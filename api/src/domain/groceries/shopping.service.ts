// Layer 9B — Grocery workflow: user shopping state on top of an immutable
// Layer 9A generated GroceryList.
//
// Generated requirement (9A: grocery_list, grocery_list_item,
// grocery_list_item_source) and user shopping state (9B: already-have,
// shopping adjustment, purchases, manual items) are separate records. 9B
// never writes a 9A row. Every state row belongs to one GroceryList
// generation; state is never carried to a later generation (a regenerated
// list starts clean; the old generation keeps its state, read-only).
// Writes are allowed only on the current (active) generation of an active or
// completed plan. History is append + revoke; nothing is edited or deleted.
//
// Scopes (20261007120000_grocery_shopping_state.sql; 33_Security_and_Privacy.md
// §8.0/§9.1): read — full_management, view_only, pediatric_weight_management;
// write — full_management, pediatric_weight_management.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { PLAN_READ_SCOPES, PLAN_WRITE_SCOPES } from '../mealPlans/mealPlan.service';
import type { GroceryDimension } from './grocery.engine';
import { loadFoods, type GroceryService } from './grocery.service';
import { itemShopping, manualShopping, SHOPPING_RULES_VERSION, type ManualItemInput as ManualRow, type PurchaseRecord, type ShoppingStatus, type StateRecord } from './shopping.engine';
import type { ManualItemInput, PurchaseInput, UserQuantityInput } from './shopping.schemas';

const STATE_COLUMNS = 'id, grocery_list_item_id, quantity, unit, note, created_at, revoked_at';
const PURCHASE_COLUMNS = 'id, grocery_list_item_id, grocery_manual_item_id, quantity, unit, note, created_at, revoked_at';
const MANUAL_COLUMNS = 'id, grocery_list_id, name, quantity, unit, food_id, notes, created_at, revoked_at';

type StateRow = StateRecord & { grocery_list_item_id: string };
type PurchaseRow = PurchaseRecord & { grocery_list_item_id: string | null; grocery_manual_item_id: string | null };
type StateTable = 'grocery_item_already_have' | 'grocery_item_shopping_adjustment';

const byTime = <T extends { created_at: string; id: string }>(a: T, b: T) => (a.created_at !== b.created_at ? (a.created_at < b.created_at ? -1 : 1) : a.id < b.id ? -1 : 1);
const num = <T extends { quantity: number | string | null }>(r: T): T => ({ ...r, quantity: r.quantity === null ? null : Number(r.quantity) });

export class ShoppingService {
  constructor(
    private readonly dbFactory: ScopedDbFactory,
    private readonly groceries: GroceryService,
  ) {}

  async view(auth: AuthContext, profileId: string, listId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    const list = await this.groceries.get(auth, profileId, listId);
    const [alreadyHave, adjustments, purchases, manual] = await Promise.all([
      db.select<StateRow>('grocery_item_already_have', { columns: STATE_COLUMNS, eq: { grocery_list_id: listId, profile_id: profileId }, limit: 10 * IN_MEMORY_PAGE_FETCH_CAP }),
      db.select<StateRow>('grocery_item_shopping_adjustment', { columns: STATE_COLUMNS, eq: { grocery_list_id: listId, profile_id: profileId }, limit: 10 * IN_MEMORY_PAGE_FETCH_CAP }),
      db.select<PurchaseRow>('grocery_purchase', { columns: PURCHASE_COLUMNS, eq: { grocery_list_id: listId, profile_id: profileId }, limit: 10 * IN_MEMORY_PAGE_FETCH_CAP }),
      db.select<ManualRow>('grocery_manual_item', { columns: MANUAL_COLUMNS, eq: { grocery_list_id: listId, profile_id: profileId }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
    ]);
    const foods = await loadFoods(db, [...list.items.flatMap((i) => (i.food ? [i.food.food_id] : [])), ...manual.flatMap((m) => (m.food_id ? [m.food_id] : []))]);
    const of = <T extends { created_at: string; id: string }>(rows: readonly T[], match: (r: T) => boolean) => rows.filter(match).map((r) => num(r as T & { quantity: number | null })).sort(byTime);

    const items = list.items.map((item) =>
      itemShopping(
        {
          id: item.id as string,
          position: item.position,
          food_id: item.food?.food_id ?? null,
          display_name: item.display_name,
          dimension: item.dimension as GroceryDimension | null,
          quantity_exact: item.quantity_exact,
          resolution_status: item.resolution_status,
          unresolved_reason: item.unresolved_reason,
        },
        {
          alreadyHave: of(alreadyHave, (r) => r.grocery_list_item_id === item.id) as StateRecord[],
          adjustments: of(adjustments, (r) => r.grocery_list_item_id === item.id) as StateRecord[],
          purchases: of(purchases, (r) => r.grocery_list_item_id === item.id),
        },
        item.food ? (foods.get(item.food.food_id) ?? null) : null,
      ),
    );
    const manualViews = [...manual].sort(byTime).map((m) =>
      manualShopping(
        num(m),
        of(purchases, (r) => r.grocery_manual_item_id === m.id),
        m.food_id ? (foods.get(m.food_id) ?? null) : null,
        m.food_id ? (foods.get(m.food_id)?.canonical_name ?? null) : null,
      ),
    );
    const activeManual = manualViews.filter((m) => m.revoked_at === null);
    const count = (views: ReadonlyArray<{ status: ShoppingStatus }>) => {
      const out: Record<ShoppingStatus, number> = { need_to_buy: 0, partially_purchased: 0, purchased: 0, already_have_sufficient: 0, no_purchase_needed: 0, comparison_unresolved: 0 };
      for (const v of views) out[v.status] += 1;
      return out;
    };
    return {
      grocery_list: {
        id: list.id,
        meal_plan_id: list.meal_plan_id,
        generation_number: list.generation_number,
        status: list.status,
        is_current_generation: list.is_current_generation,
        superseded_by_grocery_list_id: list.superseded_by_grocery_list_id,
        is_stale: list.is_stale,
        generated_at: list.generated_at,
        plan_context: list.plan_context,
        current_plan_status: list.current_plan_status,
        calculation_version: list.calculation_version,
      },
      rules_version: SHOPPING_RULES_VERSION,
      state_writable: list.status === 'active' && (list.current_plan_status === 'active' || list.current_plan_status === 'completed'),
      carry_forward: 'none' as const,
      summary: { generated: count(items), manual: count(activeManual), generated_item_count: items.length, manual_item_count: activeManual.length },
      items,
      manual_items: activeManual,
      removed_manual_items: manualViews.filter((m) => m.revoked_at !== null),
    };
  }

  async setAlreadyHave(auth: AuthContext, profileId: string, listId: string, itemId: string, input: UserQuantityInput) {
    return this.setState(auth, profileId, listId, itemId, 'grocery_item_already_have', input);
  }

  async clearAlreadyHave(auth: AuthContext, profileId: string, listId: string, itemId: string) {
    return this.clearState(auth, profileId, listId, itemId, 'grocery_item_already_have', 'No already-have quantity is recorded for this item.');
  }

  async setAdjustment(auth: AuthContext, profileId: string, listId: string, itemId: string, input: UserQuantityInput) {
    return this.setState(auth, profileId, listId, itemId, 'grocery_item_shopping_adjustment', input);
  }

  async clearAdjustment(auth: AuthContext, profileId: string, listId: string, itemId: string) {
    return this.clearState(auth, profileId, listId, itemId, 'grocery_item_shopping_adjustment', 'No shopping quantity adjustment is active for this item.');
  }

  async addItemPurchase(auth: AuthContext, profileId: string, listId: string, itemId: string, input: PurchaseInput) {
    const db = await this.writer(auth, profileId, listId);
    await requireItem(db, profileId, listId, itemId);
    const current = await this.view(auth, profileId, listId);
    const view = current.items.find((i) => i.grocery_list_item_id === itemId);
    if (!view) throw AppError.notFound('Grocery list item not found.');
    requirePurchaseMode(view.purchase_mode, input);
    await write(() => db.insert('grocery_purchase', { profile_id: profileId, grocery_list_id: listId, grocery_list_item_id: itemId, quantity: input.quantity ?? null, unit: input.unit ?? null, note: input.note ?? null }, 'id'));
    return this.view(auth, profileId, listId);
  }

  async addManualPurchase(auth: AuthContext, profileId: string, listId: string, manualId: string, input: PurchaseInput) {
    const db = await this.writer(auth, profileId, listId);
    const manual = (await db.select<ManualRow>('grocery_manual_item', { columns: MANUAL_COLUMNS, eq: { id: manualId, grocery_list_id: listId, profile_id: profileId }, limit: 1 }))[0];
    if (!manual) throw AppError.notFound('Manual grocery item not found.');
    if (manual.revoked_at !== null) throw AppError.conflict('This manual item was removed.');
    requirePurchaseMode(manual.quantity === null ? 'check_off' : 'quantity', input);
    await write(() => db.insert('grocery_purchase', { profile_id: profileId, grocery_list_id: listId, grocery_manual_item_id: manualId, quantity: input.quantity ?? null, unit: input.unit ?? null, note: input.note ?? null }, 'id'));
    return this.view(auth, profileId, listId);
  }

  async revokePurchase(auth: AuthContext, profileId: string, listId: string, purchaseId: string) {
    const db = await this.writer(auth, profileId, listId);
    const row = (await db.select<PurchaseRow>('grocery_purchase', { columns: PURCHASE_COLUMNS, eq: { id: purchaseId, grocery_list_id: listId, profile_id: profileId }, limit: 1 }))[0];
    if (!row) throw AppError.notFound('Purchase not found.');
    if (row.revoked_at !== null) throw AppError.conflict('This purchase is already revoked.');
    await write(() => db.update('grocery_purchase', { id: row.id, profile_id: profileId }, { revoked_at: new Date().toISOString(), revoked_by_account_id: auth.accountId }, 'id'));
    return this.view(auth, profileId, listId);
  }

  async addManualItem(auth: AuthContext, profileId: string, listId: string, input: ManualItemInput) {
    const db = await this.writer(auth, profileId, listId);
    if (input.food_id) {
      const found = await db.select<{ id: string }>('food', { columns: 'id', eq: { id: input.food_id }, limit: 1 });
      if (!found.length) throw AppError.validation('Invalid manual item.', { issues: [{ path: 'food_id', message: 'Food not found.' }] });
    }
    await write(() =>
      db.insert(
        'grocery_manual_item',
        { profile_id: profileId, grocery_list_id: listId, name: input.name, quantity: input.quantity ?? null, unit: input.unit ?? null, food_id: input.food_id ?? null, notes: input.notes ?? null },
        'id',
      ),
    );
    return this.view(auth, profileId, listId);
  }

  async removeManualItem(auth: AuthContext, profileId: string, listId: string, manualId: string) {
    const db = await this.writer(auth, profileId, listId);
    const manual = (await db.select<ManualRow>('grocery_manual_item', { columns: MANUAL_COLUMNS, eq: { id: manualId, grocery_list_id: listId, profile_id: profileId }, limit: 1 }))[0];
    if (!manual) throw AppError.notFound('Manual grocery item not found.');
    if (manual.revoked_at !== null) throw AppError.conflict('This manual item was already removed.');
    await write(() => db.update('grocery_manual_item', { id: manualId, profile_id: profileId }, { revoked_at: new Date().toISOString(), revoked_by_account_id: auth.accountId }, 'id'));
    return this.view(auth, profileId, listId);
  }

  private async setState(auth: AuthContext, profileId: string, listId: string, itemId: string, table: StateTable, input: UserQuantityInput) {
    const db = await this.writer(auth, profileId, listId);
    await requireItem(db, profileId, listId, itemId);
    // the insert trigger revokes the previous active value (history kept)
    await write(() => db.insert(table, { profile_id: profileId, grocery_list_id: listId, grocery_list_item_id: itemId, quantity: input.quantity, unit: input.unit, note: input.note ?? null }, 'id'));
    return this.view(auth, profileId, listId);
  }

  private async clearState(auth: AuthContext, profileId: string, listId: string, itemId: string, table: StateTable, missing: string) {
    const db = await this.writer(auth, profileId, listId);
    await requireItem(db, profileId, listId, itemId);
    const active = (await db.select<StateRow>(table, { columns: STATE_COLUMNS, eq: { grocery_list_item_id: itemId, profile_id: profileId }, limit: IN_MEMORY_PAGE_FETCH_CAP })).find((r) => r.revoked_at === null);
    if (!active) throw AppError.conflict(missing);
    await write(() => db.update(table, { id: active.id, profile_id: profileId }, { revoked_at: new Date().toISOString(), revoked_by_account_id: auth.accountId }, 'id'));
    return this.view(auth, profileId, listId);
  }

  /** Write scope + a writable generation (current generation of an active
   * or completed plan). The database enforces the same rule. */
  private async writer(auth: AuthContext, profileId: string, listId: string): Promise<ScopedDbClient> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const list = (await db.select<{ id: string; status: string; meal_plan_id: string }>('grocery_list', { columns: 'id, status, meal_plan_id', eq: { id: listId, profile_id: profileId }, limit: 1 }))[0];
    if (!list) throw AppError.notFound('Grocery list not found.');
    if (list.status !== 'active') throw AppError.conflict('This grocery list generation was superseded; its shopping state is read-only. Use the current generation.');
    const plan = (await db.select<{ status: string }>('meal_plan', { columns: 'status', eq: { id: list.meal_plan_id, profile_id: profileId }, limit: 1 }))[0];
    if (!plan || (plan.status !== 'active' && plan.status !== 'completed')) throw AppError.conflict(`Shopping state cannot change for a ${plan?.status ?? 'missing'} plan.`);
    return db;
  }
}

async function requireItem(db: ScopedDbClient, profileId: string, listId: string, itemId: string) {
  const found = await db.select<{ id: string }>('grocery_list_item', { columns: 'id', eq: { id: itemId, grocery_list_id: listId, profile_id: profileId }, limit: 1 });
  if (!found.length) throw AppError.notFound('Grocery list item not found.');
}

function requirePurchaseMode(mode: 'quantity' | 'check_off', input: PurchaseInput) {
  if (mode === 'quantity' && input.quantity === undefined) {
    throw AppError.validation('Invalid purchase.', { issues: [{ path: 'quantity', message: 'This item has a quantity: record the purchased quantity and unit.' }] });
  }
  if (mode === 'check_off' && input.quantity !== undefined) {
    throw AppError.validation('Invalid purchase.', { issues: [{ path: 'quantity', message: 'This item has no comparable quantity: record a check-off (no quantity), or set a shopping quantity first.' }] });
  }
}

/** Database refusals -> safe API errors (never the SQL message). */
async function write<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'P0002') throw AppError.notFound('Grocery list not found.');
    if (code === '42501') throw AppError.forbidden('This operation is not permitted for this profile.');
    if (code === '23514' || code === '55000' || code === '23505') throw AppError.conflict('The grocery list changed while updating shopping state. Reload and retry.');
    if (code === '23503') throw AppError.validation('A referenced grocery item or food does not exist.');
    throw err;
  }
}
