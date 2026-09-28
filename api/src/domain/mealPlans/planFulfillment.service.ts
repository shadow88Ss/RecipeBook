// Layer 8B — planned vs actual (plan fulfillment).
//
// Writes are explicit, user-asserted relationships only — never inferred,
// never AI-matched:
//   * link a CURRENT CONFIRMED PlannedMealItem to an ACTIVE consumed MealItem
//     (same_item | substitution), and revoke a link;
//   * skip a current confirmed PlannedMealItem ("confirmed intent explicitly
//     not consumed"; distinct from 8A `cancelled`), and unskip (revokes).
// Neither the PlannedMealItem nor the MealItem is modified, nothing is
// deleted, and Food/Recipe/MealLog data is never written.
//
// Scopes (20261005120000_planned_actual_links.sql; 33_Security_and_Privacy.md
// §9.2) are the Meal Planning ones, never broadened: read — full_management,
// view_only, pediatric_weight_management; write — full_management,
// pediatric_weight_management. The service pre-checks every rule for a
// precise API error; the database triggers enforce the same rules (and the
// concurrency-sensitive ones) as the backstop.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { isActive, MEAL_ITEM_COLUMNS, MEAL_LOG_COLUMNS, type MealItemRow, type MealLogRow } from '../meals/meal.dto';
import { readSnapshot } from '../meals/meal.snapshot';
import { localDateOf } from '../meals/meal.time';
import { type MealPlanRow, type PlannedItemRow, type PlanTree } from './mealPlan.dto';
import { callWrite, loadTree, PLAN_READ_SCOPES, PLAN_WRITE_SCOPES } from './mealPlan.service';
import {
  countStates,
  deriveItemFulfillment,
  FULFILLMENT_RULES_VERSION,
  MealItemChains,
  PLANNED_ACTUAL_LINK_COLUMNS,
  PLANNED_ITEM_SKIP_COLUMNS,
  sameIdentity,
  toUnplannedActualDto,
  type ItemFulfillment,
  type LinkRow,
  type SkipRow,
} from './planFulfillment';
import type { ActualLinkCreateInput, SkipCreateInput } from './planFulfillment.schemas';

const LINKABLE_PLAN_STATUSES: readonly MealPlanRow['status'][] = ['active', 'completed'];
/** consumed_at's plan-local date can differ from the MealLog's logged_date
 * (a different zone) by at most two calendar days. */
const LOG_DATE_MARGIN_DAYS = 2;

export class PlanFulfillmentService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async createLink(auth: AuthContext, profileId: string, planId: string, itemId: string, input: ActualLinkCreateInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    const { item, planDate } = requireLinkableItem(tree, itemId);
    const skips = await loadSkips(db, [item.id]);
    if (skips.some((s) => s.revoked_at === null)) throw AppError.conflict('This planned item is skipped; unskip it before linking actual consumption.');

    const actual = (await db.select<MealItemRow>('meal_item', { columns: MEAL_ITEM_COLUMNS, eq: { id: input.meal_item_id, profile_id: profileId }, limit: 1 }))[0];
    if (!actual) throw AppError.validation('Invalid actual link.', { issues: [{ path: 'meal_item_id', message: 'Meal item not found in this profile.' }] });
    if (!isActive(actual) || !actual.consumed_at) {
      throw AppError.conflict('Only an active consumed meal item can be linked (not a superseded correction record).', { active_meal_item_id: actual.superseded_by_meal_item_id });
    }
    const actualDate = localDateOf(actual.consumed_at, tree.plan.local_timezone);
    if (actualDate !== planDate) {
      throw AppError.conflict(`The meal item was consumed on ${actualDate} in the plan's time zone (${tree.plan.local_timezone}), not on the planned day ${planDate}.`);
    }
    const same = sameIdentity(item, actual);
    if (input.relationship_type === 'same_item' && !same) {
      throw AppError.validation('Invalid actual link.', { issues: [{ path: 'relationship_type', message: 'same_item needs the same Food or the exact RecipeVersion; use substitution.' }] });
    }
    if (input.relationship_type === 'substitution' && same) {
      throw AppError.validation('Invalid actual link.', { issues: [{ path: 'relationship_type', message: 'The meal item is the planned Food/RecipeVersion; use same_item.' }] });
    }

    const root = await chainRoot(db, profileId, actual);
    const chainLinks = (await db.select<LinkRow>('planned_actual_link', { columns: PLANNED_ACTUAL_LINK_COLUMNS, eq: { meal_item_chain_root_id: root }, limit: IN_MEMORY_PAGE_FETCH_CAP })).filter(
      (l) => l.revoked_at === null,
    );
    if (chainLinks.some((l) => l.planned_meal_item_id === item.id)) throw AppError.conflict('This actual consumption is already linked to the planned item.');
    const others = chainLinks.map((l) => l.planned_meal_item_id);
    if (others.length) {
      const planned = await db.select<Pick<PlannedItemRow, 'id' | 'status' | 'superseded_by_planned_meal_item_id'>>('planned_meal_item', {
        columns: 'id, status, superseded_by_planned_meal_item_id',
        in: { id: others },
      });
      if (planned.some((p) => p.status === 'confirmed' && p.superseded_by_planned_meal_item_id === null)) {
        throw AppError.conflict('This actual consumption already fulfils another current planned item; revoke that link first.');
      }
    }

    const link = await callWrite(() =>
      db.insert<LinkRow>(
        'planned_actual_link',
        { profile_id: profileId, planned_meal_item_id: item.id, meal_item_id: actual.id, relationship_type: input.relationship_type },
        PLANNED_ACTUAL_LINK_COLUMNS,
      ),
    );
    return { link: toLinkDto(link), item_fulfillment: await this.itemView(db, profileId, planId, item.id) };
  }

  async revokeLink(auth: AuthContext, profileId: string, planId: string, linkId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    const link = (await db.select<LinkRow>('planned_actual_link', { columns: PLANNED_ACTUAL_LINK_COLUMNS, eq: { id: linkId, profile_id: profileId }, limit: 1 }))[0];
    if (!link || !tree.items.some((i) => i.id === link.planned_meal_item_id)) throw AppError.notFound('Link not found in this meal plan.');
    if (link.revoked_at !== null) throw AppError.conflict('This link is already revoked.');
    requireLinkablePlan(tree.plan, 'revoked');
    const updated = await callWrite(() =>
      db.update<LinkRow>('planned_actual_link', { id: link.id, profile_id: profileId }, { revoked_at: new Date().toISOString(), revoked_by_account_id: auth.accountId }, PLANNED_ACTUAL_LINK_COLUMNS),
    );
    if (!updated) throw AppError.notFound('Link not found in this meal plan.');
    return { link: toLinkDto(updated), item_fulfillment: await this.itemView(db, profileId, planId, link.planned_meal_item_id) };
  }

  async skip(auth: AuthContext, profileId: string, planId: string, itemId: string, input: SkipCreateInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    const { item } = requireLinkableItem(tree, itemId);
    const [skips, links] = await Promise.all([loadSkips(db, [item.id]), loadLinks(db, [item.id])]);
    if (skips.some((s) => s.revoked_at === null)) throw AppError.conflict('This planned item is already skipped.');
    if (links.some((l) => l.revoked_at === null)) throw AppError.conflict('A planned item with active actual links cannot be skipped; revoke the links first.');
    const skip = await callWrite(() =>
      db.insert<SkipRow>('planned_meal_item_skip', { profile_id: profileId, planned_meal_item_id: item.id, reason: input.reason ?? null }, PLANNED_ITEM_SKIP_COLUMNS),
    );
    return { skip: toSkipDto(skip), item_fulfillment: await this.itemView(db, profileId, planId, item.id) };
  }

  async unskip(auth: AuthContext, profileId: string, planId: string, itemId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    const item = tree.items.find((i) => i.id === itemId);
    if (!item) throw AppError.notFound('Planned item not found.');
    const active = (await loadSkips(db, [item.id])).find((s) => s.revoked_at === null);
    if (!active) throw AppError.conflict('This planned item is not skipped.');
    requireLinkablePlan(tree.plan, 'revoked');
    const updated = await callWrite(() =>
      db.update<SkipRow>('planned_meal_item_skip', { id: active.id, profile_id: profileId }, { revoked_at: new Date().toISOString(), revoked_by_account_id: auth.accountId }, PLANNED_ITEM_SKIP_COLUMNS),
    );
    if (!updated) throw AppError.notFound('Skip not found.');
    return { skip: toSkipDto(updated), item_fulfillment: await this.itemView(db, profileId, planId, item.id) };
  }

  async plan(auth: AuthContext, profileId: string, planId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    return buildFulfillment(await loadFulfillmentData(db, profileId, planId));
  }

  async day(auth: AuthContext, profileId: string, planId: string, planDate: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    const data = await loadFulfillmentData(db, profileId, planId);
    const { plan } = data.tree;
    if (planDate < plan.start_date || planDate > plan.end_date) {
      throw AppError.validation('plan_date is outside the plan date range.', { issues: [{ path: 'plan_date', message: `Must be between ${plan.start_date} and ${plan.end_date}.` }] });
    }
    const full = buildFulfillment(data);
    const day = full.days.find((d) => d.plan_date === planDate) ?? emptyDay(planDate, full.unplanned_actual_items);
    return { meal_plan_id: full.meal_plan_id, status: full.status, local_timezone: full.local_timezone, rules_version: full.rules_version, basis: full.basis, ...day };
  }

  async item(auth: AuthContext, profileId: string, planId: string, itemId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    return this.itemView(db, profileId, planId, itemId);
  }

  private async itemView(db: ScopedDbClient, profileId: string, planId: string, itemId: string): Promise<ItemFulfillment> {
    const full = buildFulfillment(await loadFulfillmentData(db, profileId, planId));
    const found = [...full.days.flatMap((d) => d.items), ...full.historical_items].find((i) => i.planned_meal_item_id === itemId);
    if (!found) throw AppError.notFound('No fulfillment for this planned item: only confirmed items (current or superseded) have one.');
    return found;
  }
}

function requireLinkablePlan(plan: MealPlanRow, action: 'created' | 'revoked') {
  if (!LINKABLE_PLAN_STATUSES.includes(plan.status)) {
    throw AppError.conflict(`Links and skips can only be ${action} on an active or completed plan (this plan is ${plan.status}).`);
  }
}

function requireLinkableItem(tree: PlanTree, itemId: string): { item: PlannedItemRow; planDate: string } {
  const item = tree.items.find((i) => i.id === itemId);
  if (!item) throw AppError.notFound('Planned item not found.');
  requireLinkablePlan(tree.plan, 'created');
  if (item.status !== 'confirmed' || item.superseded_by_planned_meal_item_id !== null) {
    throw AppError.conflict(`Only a current confirmed planned item can be linked or skipped (this item is ${item.superseded_by_planned_meal_item_id ? 'superseded' : item.status}).`);
  }
  const meal = tree.meals.find((m) => m.id === item.planned_meal_id);
  const day = tree.days.find((d) => d.id === meal?.meal_plan_day_id);
  if (!day) throw AppError.internal();
  return { item, planDate: day.plan_date };
}

async function loadLinks(db: ScopedDbClient, plannedItemIds: readonly string[]): Promise<LinkRow[]> {
  if (!plannedItemIds.length) return [];
  return db.select<LinkRow>('planned_actual_link', {
    columns: PLANNED_ACTUAL_LINK_COLUMNS,
    in: { planned_meal_item_id: plannedItemIds },
    order: { column: 'created_at', ascending: true },
    limit: IN_MEMORY_PAGE_FETCH_CAP,
  });
}

async function loadSkips(db: ScopedDbClient, plannedItemIds: readonly string[]): Promise<SkipRow[]> {
  if (!plannedItemIds.length) return [];
  return db.select<SkipRow>('planned_meal_item_skip', {
    columns: PLANNED_ITEM_SKIP_COLUMNS,
    in: { planned_meal_item_id: plannedItemIds },
    order: { column: 'skipped_at', ascending: true },
    limit: IN_MEMORY_PAGE_FETCH_CAP,
  });
}

async function chainRoot(db: ScopedDbClient, profileId: string, item: MealItemRow): Promise<string> {
  let current = item;
  for (let guard = 0; current.corrects_meal_item_id && guard < 1000; guard += 1) {
    const prev = (await db.select<MealItemRow>('meal_item', { columns: MEAL_ITEM_COLUMNS, eq: { id: current.corrects_meal_item_id, profile_id: profileId }, limit: 1 }))[0];
    if (!prev) break;
    current = prev;
  }
  return current.id;
}

/** Loads MealItems until every correction chain in view is complete in
 * both directions (superseded_by and corrects). */
async function closeChains(db: ScopedDbClient, profileId: string, seed: readonly MealItemRow[], extraIds: readonly string[]): Promise<Map<string, MealItemRow>> {
  const byId = new Map(seed.map((i) => [i.id, i]));
  let missing = [...new Set(extraIds.filter((id) => !byId.has(id)))];
  for (let guard = 0; missing.length && guard < 100; guard += 1) {
    const rows = await db.select<MealItemRow>('meal_item', { columns: MEAL_ITEM_COLUMNS, eq: { profile_id: profileId }, in: { id: missing }, limit: IN_MEMORY_PAGE_FETCH_CAP });
    for (const r of rows) byId.set(r.id, r);
    const requested = new Set(missing);
    missing = [
      ...new Set(
        [...byId.values()].flatMap((i) => [i.superseded_by_meal_item_id, i.corrects_meal_item_id]).filter((id): id is string => id !== null && !byId.has(id) && !requested.has(id)),
      ),
    ];
  }
  return byId;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

interface FulfillmentData {
  tree: PlanTree;
  links: LinkRow[];
  skips: SkipRow[];
  logs: MealLogRow[];
  chains: MealItemChains;
  /** Active links (any plan) on the chains in view. */
  chainLinks: LinkRow[];
  /** Current (confirmed, not superseded) planned item ids among chainLinks. */
  currentLinkedPlannedIds: Set<string>;
}

async function loadFulfillmentData(db: ScopedDbClient, profileId: string, planId: string): Promise<FulfillmentData> {
  const tree = await loadTree(db, profileId, planId);
  const itemIds = tree.items.map((i) => i.id);
  const [links, skips] = await Promise.all([loadLinks(db, itemIds), loadSkips(db, itemIds)]);
  const logDates = datesBetween(addDays(tree.plan.start_date, -LOG_DATE_MARGIN_DAYS), addDays(tree.plan.end_date, LOG_DATE_MARGIN_DAYS));
  const logs = await db.select<MealLogRow>('meal_log', { columns: MEAL_LOG_COLUMNS, eq: { profile_id: profileId }, in: { logged_date: logDates }, limit: IN_MEMORY_PAGE_FETCH_CAP });
  const windowItems = logs.length
    ? await db.select<MealItemRow>('meal_item', {
        columns: MEAL_ITEM_COLUMNS,
        eq: { profile_id: profileId },
        in: { meal_log_id: logs.map((l) => l.id) },
        order: { column: 'created_at', ascending: true },
        limit: IN_MEMORY_PAGE_FETCH_CAP,
      })
    : [];
  const chains = new MealItemChains(await closeChains(db, profileId, windowItems, links.map((l) => l.meal_item_id)));

  const roots = [...new Set(chains.active().map((i) => chains.root(i.id)))];
  const chainLinks = roots.length
    ? (await db.select<LinkRow>('planned_actual_link', { columns: PLANNED_ACTUAL_LINK_COLUMNS, in: { meal_item_chain_root_id: roots }, limit: IN_MEMORY_PAGE_FETCH_CAP })).filter(
        (l) => l.revoked_at === null,
      )
    : [];
  const inTree = new Map(tree.items.map((i) => [i.id, i]));
  const outside = [...new Set(chainLinks.map((l) => l.planned_meal_item_id).filter((id) => !inTree.has(id)))];
  const outsideRows = outside.length
    ? await db.select<Pick<PlannedItemRow, 'id' | 'status' | 'superseded_by_planned_meal_item_id'>>('planned_meal_item', { columns: 'id, status, superseded_by_planned_meal_item_id', in: { id: outside } })
    : [];
  const currentLinkedPlannedIds = new Set(
    [...tree.items, ...outsideRows].filter((p) => p.status === 'confirmed' && p.superseded_by_planned_meal_item_id === null).map((p) => p.id),
  );
  return { tree, links, skips, logs, chains, chainLinks, currentLinkedPlannedIds };
}

function emptyDay(planDate: string, unplanned: ReturnType<typeof buildFulfillment>['unplanned_actual_items']) {
  const dayUnplanned = unplanned.filter((u) => u.plan_local_date === planDate);
  return { meal_plan_day_id: null, plan_date: planDate, state_counts: countStates([]), items: [] as ItemFulfillment[], unplanned_actual_items: dayUnplanned };
}

function buildFulfillment(data: FulfillmentData) {
  const { tree, chains } = data;
  const { plan } = tree;
  const tz = plan.local_timezone;
  const mealById = new Map(tree.meals.map((m) => [m.id, m]));
  const dayById = new Map(tree.days.map((d) => [d.id, d]));
  const dateOfItem = (i: PlannedItemRow) => dayById.get(mealById.get(i.planned_meal_id)?.meal_plan_day_id ?? '')?.plan_date ?? '';

  const derive = (i: PlannedItemRow) =>
    deriveItemFulfillment({
      item: i,
      plannedSnapshot: readSnapshot(i.nutrition_snapshot),
      planDate: dateOfItem(i),
      timeZone: tz,
      mealType: mealById.get(i.planned_meal_id)?.meal_type ?? '',
      links: data.links.filter((l) => l.planned_meal_item_id === i.id),
      skips: data.skips.filter((s) => s.planned_meal_item_id === i.id),
      chains,
    });

  const byPosition = (a: PlannedItemRow, b: PlannedItemRow) => {
    const ma = mealById.get(a.planned_meal_id);
    const mb = mealById.get(b.planned_meal_id);
    const mp = (ma?.position ?? 0) - (mb?.position ?? 0);
    if (mp) return mp;
    if (a.planned_meal_id !== b.planned_meal_id) return a.planned_meal_id < b.planned_meal_id ? -1 : 1;
    return a.position !== b.position ? a.position - b.position : a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  };
  const current = tree.items.filter((i) => i.status === 'confirmed' && i.superseded_by_planned_meal_item_id === null).sort(byPosition);
  // superseded confirmed intent that has link/skip history stays explainable
  const historical = tree.items
    .filter((i) => i.status === 'confirmed' && i.superseded_by_planned_meal_item_id !== null)
    .filter((i) => data.links.some((l) => l.planned_meal_item_id === i.id) || data.skips.some((s) => s.planned_meal_item_id === i.id))
    .sort(byPosition)
    .map((i) => ({ ...derive(i), is_current: false as const, superseded_by_planned_meal_item_id: i.superseded_by_planned_meal_item_id }));

  // Actual side: active records whose consumed_at falls in the plan range (plan-local).
  const logById = new Map(data.logs.map((l) => [l.id, l]));
  const linkedToThisPlan = new Set<string>();
  const linkedElsewhere = new Set<string>();
  const treeIds = new Set(tree.items.map((i) => i.id));
  for (const l of data.chainLinks) {
    if (!data.currentLinkedPlannedIds.has(l.planned_meal_item_id)) continue;
    (treeIds.has(l.planned_meal_item_id) ? linkedToThisPlan : linkedElsewhere).add(l.meal_item_chain_root_id);
  }
  const activeInRange = chains
    .active()
    .filter((i) => i.consumed_at !== null && logById.has(i.meal_log_id))
    .map((i) => ({ item: i, date: localDateOf(i.consumed_at as string, tz), root: chains.root(i.id) }))
    .filter((x) => x.date >= plan.start_date && x.date <= plan.end_date)
    .sort((a, b) => (a.item.consumed_at as string).localeCompare(b.item.consumed_at as string) || (a.item.id < b.item.id ? -1 : 1));
  const unplanned = activeInRange
    .filter((x) => !linkedToThisPlan.has(x.root) && !linkedElsewhere.has(x.root))
    .map((x) => toUnplannedActualDto(x.item, x.date, logById.get(x.item.meal_log_id)?.meal_type ?? null));
  const linkedToOtherPlans = activeInRange.filter((x) => !linkedToThisPlan.has(x.root) && linkedElsewhere.has(x.root)).map((x) => ({ meal_item_id: x.item.id, plan_local_date: x.date }));

  const days = [...tree.days]
    .sort((a, b) => (a.plan_date < b.plan_date ? -1 : 1))
    .map((day) => {
      const items = current.filter((i) => dateOfItem(i) === day.plan_date).map(derive);
      return {
        meal_plan_day_id: day.id as string | null,
        plan_date: day.plan_date,
        state_counts: countStates(items),
        items,
        unplanned_actual_items: unplanned.filter((u) => u.plan_local_date === day.plan_date),
      };
    });
  const allCurrent = days.flatMap((d) => d.items);

  return {
    meal_plan_id: plan.id,
    status: plan.status,
    local_timezone: tz,
    start_date: plan.start_date,
    end_date: plan.end_date,
    rules_version: FULFILLMENT_RULES_VERSION,
    basis: {
      planned: 'confirmed_planned_item_snapshots' as const,
      actual: 'active_meal_item_snapshots_via_correction_chain' as const,
      day_matching: 'consumed_at_in_plan_local_timezone' as const,
      derived: true as const,
    },
    state_counts: countStates(allCurrent),
    current_confirmed_item_count: allCurrent.length,
    unconfirmed_current_item_ids: tree.items.filter((i) => (i.status === 'draft' || i.status === 'planned') && i.supersedes_planned_meal_item_id === null).map((i) => i.id),
    cancelled_item_ids: tree.items.filter((i) => i.status === 'cancelled').map((i) => i.id),
    days,
    unplanned_actual_items: unplanned,
    // the subset on plan dates that have no MealPlanDay row
    unplanned_actual_items_outside_planned_days: unplanned.filter((u) => !tree.days.some((d) => d.plan_date === u.plan_local_date)),
    actual_items_linked_to_other_plans: linkedToOtherPlans,
    historical_items: historical,
  };
}

function toLinkDto(l: LinkRow) {
  return {
    id: l.id,
    planned_meal_item_id: l.planned_meal_item_id,
    meal_item_id: l.meal_item_id,
    relationship_type: l.relationship_type,
    created_at: l.created_at,
    revoked_at: l.revoked_at,
    is_active: l.revoked_at === null,
  };
}

function toSkipDto(s: SkipRow) {
  return { id: s.id, planned_meal_item_id: s.planned_meal_item_id, reason: s.reason, skipped_at: s.skipped_at, revoked_at: s.revoked_at, is_active: s.revoked_at === null };
}
