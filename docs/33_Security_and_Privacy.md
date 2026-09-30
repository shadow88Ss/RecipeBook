# 33_Security_and_Privacy.md
# Phase 1 — Security and Privacy

**Status:** Phase 1 specification — authorization model and retention/deletion/export classification. No RLS policies or migrations exist yet.
**Authority:** Subordinate to `00_Master.md`. Where anything below appears to conflict with `00_Master.md`, the Master controls.
**Supersedes:** `ACCOUNT_DELETION.md`, `CHILD_DATA_PRIVACY.md`, `CONSENT_MANAGEMENT.md`, `DATA_ENCRYPTION.md`, `DATA_EXPORT.md` (retained under `docs/fragments/` as historical source material; `CHILD_DATA_PRIVACY.md` is additionally updated in place to fold in the pediatric carve-out).

---

## 1. Purpose

This document defines, for Phase 1: the Account→Profile and guardian→child authorization model sufficient to design Row Level Security later, and the retention/deletion/export classification for Phase 1 entities. It does not define RLS policy syntax or migrations — those are implementation, gated on explicit approval.

---

## 2. Authorization Model (for future RLS)

### 2.1 Account → Profile

An Account may access a Profile if and only if it is the owning Account (`Account 1..N Profile`, per `29_Data_Model.md` §2). Every profile-scoped data access — direct table read/write and API request alike — must resolve through this relationship. No table exposes Profile-scoped data to a client without the server (or RLS policy, once implemented) having verified this relationship for the requesting Account.

### 2.2 Guardian → Child Profile

A child Profile (`Profile` where `ChildProfileExtension` applies) is never accessed via a child's own credentials — per Master §7.4, a child does not independently authenticate. Access instead flows through `GuardianAuthorization` (`29_Data_Model.md` §11): an Account may access a child Profile if and only if it holds an active (`revoked_at IS NULL`) `GuardianAuthorization` row for that Profile.

This is deliberately modeled as a distinct join, not reused from ordinary Account↔Profile ownership, so that:

- guardian access can be scoped (`authorization_scope`) and revoked independently of profile existence;
- future support for shared/co-guardian access (e.g. two parent Accounts, per `19_Family_and_Multi_Profile.md`) doesn't require redesigning the ownership model;
- an audit trail of consent/revocation exists independent of the profile row itself.

### 2.3 RLS readiness

Given the above, the two policies Phase 1 RLS design must implement (when migrations are written) are:
1. `profile` row visible/writable to an Account where `profile.account_id = auth.uid()` (or equivalent), **or**
2. `profile` row visible/writable to an Account where an active `guardian_authorization` row links that Account to the profile.

Every Profile-scoped table (MealLog, MealItem, Goal, NutritionTarget, ClinicianTarget, WeightMeasurement, RecipePersonalizedVariant, WearableConnection, etc.) inherits isolation transitively through its `profile_id` foreign key and the same two-clause policy shape. This document fixes the shape; the literal policy SQL is written in Phase 1 implementation, not here.

### 2.4 Sensitive-action reauthentication

Per the NFR security requirement and `DEVICE_TRUST.md`, actions that materially change guardian authorization, delete an account, or export sensitive data require a fresh reauthentication signal from Supabase Auth (recent session / step-up), not merely a valid long-lived session token. The exact reauthentication mechanism is a `37_Authentication_and_Login.md` concern; this document only fixes that such actions are in-scope for that requirement.

### 2.5 Cross-Guardian Administration Boundary

**Approved principle: managing the CHILD does not imply authority to manage ANOTHER GUARDIAN.** This applies to every `GuardianAuthorization` scope, including `full_management` — a scope that grants broad authority over a child Profile's own data (Goal, MealLog, ClinicianTarget, etc.) grants **no** authority whatsoever over a *different* guardian's `GuardianAuthorization` row for that same child. Specifically, holding `full_management` on a child does not by itself permit an Account to:

- revoke another guardian's authorization;
- modify another guardian's `authorization_scope`;
- replace another guardian's authorization;
- grant authorization to a new guardian (delegation/invitation).

`granted_by_account_id` is provenance (who performed a grant), never an implicit administrative capability over guardians other than the one it references. No "primary guardian" concept exists in Phase 1.

For the current version, an Account may only:
- self-grant its own first (`bootstrap`) authorization for a child Profile it created — the one and only case `profile.account_id` acts as a trust anchor for a child profile, per §2.2;
- relinquish (revoke) **its own** authorization, where the approved workflow permits it.

Cross-guardian authorization administration — adding a second or subsequent guardian, or altering/revoking another guardian's grant — is **not part of ordinary `GuardianAuthorization` scopes** in Phase 1. It must be implemented later through a separately designed, explicitly authorized guardian-management/administrative workflow (e.g. an invitation-and-acceptance flow, or a service-role-mediated administrative action) — not inferred from `full_management` or any other ordinary scope.

This does not remove multi-guardian support as a data-model capability: multiple simultaneously-active `GuardianAuthorization` rows for one child remain fully supported, isolated from each other, and independently scoped and revocable (§2.2) — only the *mechanism* for an ordinary authenticated client to add a second guardian is deferred to that future workflow, rather than granted through `full_management` today.

---

## 3. Child Data Minimization (aligned with Master §10)

`CHILD_DATA_PRIVACY.md`'s original "parent-controlled access, minimal data collection" statement is retained as the default posture, with the Master §10 carve-out made explicit here:

- Default: collect and retain only child data required for an enabled feature, safety, legal/compliance obligation, or explicit guardian-authorized entry. No speculative collection.
- Carve-out: when a guardian explicitly enables the pediatric weight-management workflow (`21_Pediatric_Weight_Management.md`), the platform may store the minimum longitudinal data that workflow requires — anthropometric measurements, relevant target information, growth/safety context, measurement dates, provenance — under `GuardianAuthorization.authorization_scope`. This is not a general waiver; every such field still requires its own documented purpose, access rule, retention rule, and deletion/export behavior (§4 below).
- Child recommendations never use adult dieting logic (Master §10.3) — this is a product/AI-agent rule, not a data-model rule, but the data model must not make adult-only fields (e.g. aggressive deficit targets) reachable for a child `Profile` without a pediatric-safety gate having produced them.

---

## 4. Retention, Deletion, and Export Classification (Phase 1 entities)

| Category | Entities | Retention | Deletion behavior | Export behavior |
|---|---|---|---|---|
| Account/Auth | `Account`, `AuthIdentity`, `DeviceSession` | While account active (Master §14.1) | On verified deletion request: delete or irreversibly anonymize, except where legally required to retain | Included in account export |
| Adult Profile | `Profile` (adult), `Goal`, `NutritionTarget` | While profile active | Deleted/anonymized with profile deletion, subject to legal requirements | Included in profile export |
| Child Profile | `Profile` (child), `ChildProfileExtension`, `GuardianAuthorization` | Stricter minimization (Master §14.3); no indefinite retention for analytics/model-improvement purposes | Deleted on guardian-verified deletion request; a revoked `GuardianAuthorization` row is not deleted at revocation time — it is retained as an audit record of the grant/revocation event (not as ongoing access) until the child Profile itself is deleted | Guardian-initiated export only |
| Health/clinical | `WeightMeasurement`, `ClinicianTarget`, `PregnancyProfile`, `PostpartumProfile`, `BreastfeedingProfile`, `CycleRecord` | While profile active; child instances follow the Child Profile row above | Deleted/anonymized with profile deletion | Included in profile/guardian export |
| Nutrition history | `MealLog`, `MealItem`, `EffectiveTargetSnapshot` | While profile active — powers history/analytics (Master §14.2) | Deleted/anonymized with profile deletion | Included in profile export |
| Raw imported content | `UrlSource` (persistent source identity), `ImportJob` (per-attempt processing record), `RawContent` (per-attempt raw artifact) | Operational/provenance window only — extraction verification, provenance, user-requested saved content, or a bounded dispute/debug window; **not** unlimited archival (Master §14.4) | Purged per the retention window even without a deletion request; also purged on profile/account deletion. `UrlSource` may outlive an individual purged `ImportJob`/`RawContent` if other, more recent `ImportJob` rows against the same source remain in-window. | Not included in standard export beyond what the user explicitly saved as a Recipe |
| AI extraction | `AiExtraction` | Tied to its parent `RawContent`'s retention window | Purged with `RawContent` | Not separately exported |
| Recipes (normalized) | `Recipe`, `RecipeVersion`, `RecipePersonalizedVariant` | Persistent library content — retained independent of the raw source's retention window once normalized and saved by the user | User-deletable individually; deleted with account/profile deletion otherwise | Included in profile export |
| Wearable data | `WearableConnection`, `Activity`, `Workout`, `Sleep`, `Recovery` | While profile active and connection remains authorized | Deleted/anonymized on disconnection or profile deletion, per provider terms | Included in profile export |
| Audit | `AuditEvent` | Per Master §14.5 — logs exclude raw health/nutrition content; retention period set explicitly before production release | Not user-deletable on demand (security/audit integrity); purged per a documented log-retention schedule | Not included in standard user export |

Concrete retention **durations** (e.g. "90 days" for raw content) are not fixed by this document — Master §14.4 explicitly requires that period be set before production release, considering copyright/platform restrictions. That remains an open, non-blocking item for a later specification pass, not a Phase 1 blocker (no migration depends on knowing the exact number yet, only on the category existing).

---

## 5. Consent

- Wearable connection, cycle tracking, pregnancy/postpartum/breastfeeding context, child-profile features, and notifications each require their own granular opt-in, consistent with `CONSENT_MANAGEMENT.md`'s original scope.
- Consent state for a child feature is captured via `GuardianAuthorization.consented_at` / `revoked_at`, not a separate free-floating consent table, to keep guardian consent and guardian access as one auditable concept.

---

## 6. Encryption

- TLS in transit; encryption at rest for the Supabase/PostgreSQL data store, consistent with `DATA_ENCRYPTION.md`'s original scope and Master §15.
- Secrets (API keys, service-role keys, OAuth client secrets) are never stored in application tables and never shipped to the mobile client (Master §30) — this is an operational/config rule, not a data-model entity.

---

## 7. AI Training Exclusion

Per Master §14.6: user health, nutrition, child, pregnancy, or family data is not repurposed for model training by this application. No entity in `29_Data_Model.md` is assumed to feed a training pipeline; if that ever changes it requires a separate explicit consent/governance mechanism and is out of scope for Phase 1.

---

## 8. Ownership and RLS Inputs

Per-entity inputs sufficient for RLS policies to be generated deterministically once migrations are written. This section does not write policy SQL — it fixes, for every Phase 1 entity, the five inputs an RLS policy needs: owning Profile, owning/authorized Account relationship, whether guardian access applies, the access mode, and whether historical/audit rows are immutable.

| Entity | Owning Profile | Account relationship | Guardian access | Access mode | Historical/immutable |
|---|---|---|---|---|---|
| Account | — (Account-scoped, not Profile-scoped) | self (`account_id = auth.uid()`) | n/a | RW own row only | no |
| AuthIdentity | — | owning Account only | n/a | RW own | link/unlink audited; not freely mutable |
| DeviceSession | — | owning Account only | n/a | read list; write = revoke only | revoked rows retained, not deleted |
| Profile | self | owning Account (direct), or an Account holding an active `GuardianAuthorization` | yes, for child profiles | RW per role (owner full; guardian per `authorization_scope`) | no |
| ChildProfileExtension | the child Profile | via Profile's owning/guardian Account | yes (guardian only — child never authenticates) | RW by guardian only | no |
| GuardianAuthorization | the child Profile (`child_profile_id`) | `guardian_account_id` | n/a (this **is** the guardian-access record) | guardian: read own grants; grant/revoke via explicit action only | yes — append-only for consent history; revoke sets `revoked_at`, never deletes the row |
| Goal | owning Profile | via Profile | yes (guardian RW on behalf of child) | RW by profile owner/guardian | no |
| NutritionTarget | owning Profile | via Profile | yes | RW by profile owner/guardian | superseded rows retained, not deleted |
| ClinicianTarget | owning Profile | via Profile | yes (guardian enters on behalf of child) | RW by profile owner/guardian for value entry; `verification_status` write-restricted to an approved verification workflow | superseded rows retained |
| WeightMeasurement | owning Profile | via Profile | yes | RW by profile owner/guardian | yes — correction creates a new row, original retained |
| EffectiveTargetSnapshot | owning Profile | via Profile | yes (guardian read on behalf of child) | read-only after creation; never user-writable (Layer 10A daily capture: server-resolved content, client supplies only date + time zone) | yes — fully immutable |
| MealLog | owning Profile | via Profile | yes | RW by profile owner/guardian | status derived from MealItem, see below |
| MealItem | owning Profile (via MealLog) | via Profile | yes | RW while `draft`/`planned`; `confirmed` = suggestion-only; `consumed` = correction-only | yes for `consumed` rows — correction creates a new row |
| Food | — (global reference data) | n/a | n/a | read-only to all authenticated clients; write restricted to trusted data-ingestion service role | curated, not user-mutable |
| FoodAlias | — (global) | n/a | n/a | read-only; write via trusted service/validated AI | curated |
| FoodServing | — (global) | n/a | n/a | read-only; write via trusted service | curated |
| Nutrient | — (global) | n/a | n/a | read-only | curated, rarely changes |
| FoodNutrient | — (global) | n/a | n/a | read-only | curated |
| Recipe | shared/canonical once normalized; `created_by_*` is attribution only, not exclusive ownership | originating Account/Profile (attribution) | n/a directly (guardian access to a child's *saved/personalized* copy runs through `RecipePersonalizedVariant`, not the shared Recipe) | read: per `visibility`/Recipe Library rules (owned by `10_Recipe_Library.md`); write: only via the recipe-intelligence/import pipeline or an explicit edit producing a new `RecipeVersion` | RecipeVersion history immutable once created |
| RecipeVersion | via parent Recipe | originating Account/Profile (attribution) | n/a | read broad (per Recipe visibility); write append-only, never edited in place | yes — immutable once created |
| RecipeIngredient | via Recipe/RecipeVersion | same as RecipeVersion | n/a | read broad; write only via RecipeVersion creation | yes — immutable per version |
| RecipeInstruction | via Recipe/RecipeVersion | same | n/a | same | yes |
| RecipePersonalizedVariant | owning Profile | via Profile | yes (guardian on behalf of child) | RW by profile owner/guardian only — never shared/public | `user_accepted_at` write-once; adjustments editable before acceptance |
| UrlSource | — (resource identity, not profile-scoped) | attribution flows through `ImportJob.requested_by_account_id`, not stored directly on `UrlSource` | n/a directly | read/write restricted to the service layer; not directly client-writable | append-only in practice (fields updated by system on each attempt, not by client edit) |
| ImportJob | attributed via `requested_by_profile_id` | `requested_by_account_id` | n/a directly (a guardian acting for a child profile can be the `requested_by_account_id`) | RW restricted to the initiating Account for visibility/retry actions; `processing_status` written by system/worker only | yes — forward-only state machine, not re-editable once terminal |
| RawContent | via ImportJob → initiating Profile | via ImportJob's initiating Account | same as ImportJob | read restricted to initiating Account + trusted service; never client-writable directly | yes — immutable, new `ImportJob` produces a new row |
| AiExtraction | via RawContent → initiating Profile | via RawContent's initiating Account | same | read restricted to initiating Account; write only by the AI pipeline service role | yes — immutable once created |
| WearableConnection | owning Profile | via Profile | yes | RW by profile owner/guardian (connect/disconnect); sync fields written by worker/service role only | connection metadata mutable; historical sync entries immutable |
| Activity / Workout / Sleep / Recovery | owning Profile (via WearableConnection) | via Profile | yes | read by profile owner/guardian; write by sync worker only (idempotent upsert), plus explicit `user_override` | upserts idempotent by `provider_record_id`, not free-form edits |
| AuditEvent | may reference a subject Account/Profile | subject Account/Profile (read visibility limited/none to end user by default) | n/a | write-only by system (append); read restricted to security/audit tooling, not general user-facing API by default | yes — fully immutable, append-only |

This table is the deterministic input set for writing RLS policies in Phase 1 implementation. No RLS policy SQL is authored in this specification pass.

### 8.0 Meal Planning ownership (Phase 2 Layer 8A)

| Entity | Owner | Access | Child-sensitive | Mutation |
|---|---|---|---|---|
| MealPlan / MealPlanDay / PlannedMeal / PlannedMealItem | owning Profile (denormalized `profile_id`, composite-FK enforced) | read: full_management, view_only, pediatric_weight_management; write: full_management, pediatric_weight_management | conditional | plan lifecycle by transition only; days/meals insert-only; items editable while draft/planned, immutable once confirmed (replacement only); no DELETE |
| PlannedActualLink / PlannedMealItemSkip (Layer 8B) | owning Profile (composite FKs to both the PlannedMealItem and the MealItem, same `profile_id`) | read: full_management, view_only, pediatric_weight_management; write (create, revoke): full_management, pediatric_weight_management | conditional | insert + one-time revocation only (revoked rows immutable); actor ids forced to `auth.uid()`; no DELETE |
| GroceryList / GroceryListItem / GroceryListItemSource (Layer 9A) | owning Profile (composite FKs to the list, the MealPlan and every referenced plan row, same `profile_id`) | read: full_management, view_only, pediatric_weight_management; generate (insert): full_management, pediatric_weight_management | conditional | insert-only inside one generating transaction, then sealed; the only update is the trigger-performed supersession of the previous generation; no UPDATE/DELETE grants |
| GroceryManualItem / GroceryItemAlreadyHave / GroceryItemShoppingAdjustment / GroceryPurchase (Layer 9B) | owning Profile (composite FKs to the list and, where applicable, the item/manual item of the same list) | read: full_management, view_only, pediatric_weight_management; write (insert, revoke): full_management, pediatric_weight_management | conditional | append + one-time revocation; only on the current generation of an active/completed plan; actor ids forced to `auth.uid()`; no DELETE |

**Layer 10A (historical target context).** Daily target snapshots (`effective_target_snapshot`, reason `daily_tracking`) are created only through `POST /target-snapshots`: the client supplies `local_date` + IANA `timezone`; values, provenance, resolver version and unresolved fields come from the single server resolver — **application-authoritative, not cryptographically attested** (as §8.1: an Account with capture scope could insert a fabricated snapshot for that Profile directly). Enforced by the database regardless of path: RLS insert only for `full_management` (owners resolve to it), SELECT for full_management/view_only/pediatric_weight_management; no UPDATE (trigger) or DELETE grant; one daily snapshot per Profile + date; only the current local date; actor and creation time forced. Pediatric snapshot creation remains denied (§9) — not broadened for reporting convenience.

**Layer 10B (progress & adherence).** `GET /progress` is a read model: it runs as the caller under existing RLS (read scopes full_management, view_only, pediatric_weight_management on every source table), writes nothing, and exposes no actor ids. It reports three factual dimensions without a combined score or evaluative labels; for child Profiles it adds no weight-loss success, deficit, compliance, growth or BMI-percentile interpretation (Master §10, §8.4). Closure (Master §8.5): fulfillment is separate factual rates with an explicit denominator, Goal progress has no percentage and no inferred baseline, and the database allows only one direct correction per WeightMeasurement (history is never deleted; legacy branches stay excluded as `conflicting_correction`). Test-only fixture bypasses (historical 10A snapshots written with triggers disabled; a legacy-branch database built before the invariant migration) live only in integration tests; no production rule, trigger or RLS policy is weakened.

Planned-item nutrition snapshots follow the same trust boundary as §8.1: server-computed at confirmation, **application-authoritative, not cryptographically attested**; the API never accepts a client snapshot.

**Layer 8B (planned vs actual).** Links and skips store relationships only; the API accepts `meal_item_id`, `relationship_type` and an optional skip `reason` — never a fulfillment state, quantity or nutrition value. Their insert triggers are SECURITY DEFINER (search_path pinned, execute revoked from public) and check the caller's write scope on the row's Profile **before** reading any planned or actual row, so they cannot be used to probe another Profile; profile consistency is also enforced by composite FKs. Race-sensitive invariants (skip vs link, one actual chain → one current planned item) are serialized with transaction-scoped advisory locks. Fulfillment is derived from the stored planned and actual snapshots (§8.1 trust boundary applies to both). Read endpoints perform no writes.

**Layer 9A (grocery planning).** Generation accepts no client grocery data: quantities, statuses and traceability are computed by the server engine and written through the SECURITY INVOKER `generate_grocery_list()` — **application-authoritative, not cryptographically attested** (same limitation as §8.1: an Account with write scope could call the function directly with fabricated quantities for that Profile only). Enforced by the database whatever the path: RLS and composite Profile keys (no cross-Profile list, plan or source, even for an Account managing several Profiles); the caller's write scope is checked by the SECURITY DEFINER insert triggers before any row is read; generation only from an `active` plan; every source row is a current, confirmed, non-skipped planned item of that plan whose structured facts (Food/serving/unit/quantity or exact RecipeVersion/servings/ingredient/yield) match; lists are sealed after the generating transaction and never updated except by the one-time supersession. Generation is serialized per plan with a transaction-scoped advisory lock. Grocery data holds no payment, retailer or location data.

**Layer 9B (shopping state).** Clients submit user facts only (already-have, intended shopping quantity, purchases, manual items); the generated 9A rows have no UPDATE/DELETE grant and are never written by 9B. State tables are insert + revoke-only (triggers force actor/time, allow revocation once, and refuse any other change). SECURITY DEFINER triggers check the caller's write scope and that the list belongs to the row's Profile and is the current generation of an active/completed plan before reading anything else; composite FKs bind every row to its list's Profile and every item/manual-item reference to the same list, so an Account managing several Profiles cannot attach state across Profiles or generations. Shopping state contains no payment, retailer, price or location data.

**Layer 11A (products & barcodes).** Product, ProductLabelVersion, ProductNutrient, ProductServing and Barcode are global reference data like the food tables: SELECT for `authenticated` (any Account), no INSERT/UPDATE/DELETE grant or policy, DELETE blocked by trigger for every role, label rows sealed after publication, barcode rows immutable except retirement. Writes (including label publication and barcode retirement/reuse) belong to trusted ingestion/admin workflows only; `publish_product_label_version()` is not executable by clients and no API endpoint writes product data. Barcode lookup requires normal authentication (no anonymous endpoint). No user-entered data is stored as global product data or labelled manufacturer-verified. New `food_nutrient` rows are `trusted_database` only (label nutrition belongs to Product). Test fixtures insert products as the database owner; the legacy-Food fixture helper recreates the pre-11A state only in the test's throwaway database.

**Layer 11B (product meal logging).** No policy added or broadened: Product MealItems use the existing meal RLS (read: full_management, view_only, pediatric_weight_management; write: full_management, pediatric_weight_management; view_only `403`; revoked/unrelated `404`) and MealItem/MealLog profile consistency. Logging reads Product reference data and writes only `meal_item`; clients still cannot write Product tables. Composite FKs block a label version of another Product, a serving of another label version and a barcode of another Product; a definer trigger blocks a label replaced before consumption (so a direct RPC call cannot pick an old label) and a retired barcode. Snapshots stay application-authoritative (§18 known limitation applies unchanged). Pediatric logging is factual consumption only — no advice, restriction or interpretation.

### 8.1 Consumed nutrition snapshot trust boundary (Phase 2 Layer 7A)

- **Supported write path:** client → `/v1` API → deterministic nutrition engine → user-scoped Supabase/Postgres connection → RLS → `MealItem.nutrition_snapshot`. Official clients must use the API for meal creation, MealItem creation and corrections; they submit consumption facts and must never construct or submit a `nutrition_snapshot` (the API's request schemas do not accept one).
- **Guarantee:** snapshots are **application-authoritative** historical records computed by the server engine — **not cryptographically attested**.
- **Known limitation:** the API and a direct Supabase client use the same user-scoped database identity, so an Account with legitimate write permission to a Profile could bypass the API and store a fabricated (correctly shaped) snapshot for **that Profile only**. Still enforced by the database regardless of path: Profile/Account isolation (RLS), consumed-row immutability (including snapshots), correction-chain integrity and its AuditEvent, the Food/Recipe and same-Profile recipe invariants, the local-day rule, and the read-only status of global reference data.
- **Future hardening (not implemented):** server-signed snapshots verified in the database (signing key with key id, Vault-style secret storage, pgcrypto, canonical serialization, rotation, optional nonce). Requires a separate architecture/security review; no design is committed.

---

## 9. `pediatric_weight_management` Access Matrix

This resolves the gap the Phase 1 RLS Security Report flagged: `authorization_scope` fixes the value `pediatric_weight_management` (`29_Data_Model.md` §11), but until now nothing mapped it to specific tables/operations. This scope allows an authorized guardian to manage the child's nutrition and pediatric weight-management workflow. **It is not equivalent to `full_management`.**

For the authorized child Profile:

| Entity | Access |
|---|---|
| Profile | Read only, limited to information required for nutrition, growth, activity and pediatric safety |
| ChildProfileExtension | Read only |
| GuardianAuthorization | No management access — cannot grant, revoke, or modify another guardian's authorization |
| Goal | SELECT + INSERT + permitted UPDATE/management |
| NutritionTarget | SELECT + INSERT, per the existing target/supersession rules |
| ClinicianTarget | SELECT only — this scope alone must never represent the guardian as a verified clinician or create a clinician-target row, verified or not |
| WeightMeasurement | SELECT + INSERT; existing historical measurements remain immutable |
| EffectiveTargetSnapshot | SELECT only |
| MealLog | SELECT + INSERT + permitted management required for nutrition logging |
| MealItem | SELECT + INSERT + lifecycle-permitted operations; consumed-history immutability and correction rules are unchanged |
| Recipe | Access only where required to use recipes legitimately available to the child Profile |
| RecipeVersion | SELECT where its parent Recipe is accessible |
| RecipeIngredient | SELECT where its RecipeVersion is accessible |
| RecipeInstruction | SELECT where its RecipeVersion is accessible |
| RecipePersonalizedVariant | SELECT + permitted creation/management for variants belonging to the child Profile |
| Food / FoodAlias / FoodServing / Nutrient / FoodNutrient | SELECT (same as every authenticated caller) |
| Activity | SELECT |
| Workout | SELECT |
| WearableConnection | No management access (no connect/disconnect/sync-field writes) |
| Sleep | No access, initially |
| Recovery | No access, initially |
| Account / AuthIdentity / DeviceSession | No access |
| UrlSource / ImportJob / RawContent / AiExtraction | No direct access |
| AuditEvent | No direct access |

### 9.1 Future meal-plan / progress / grocery scope (MealPlan implemented in Phase 2 Layer 8A)

**Layer 8A:** the MealPlan part of this scope is now implemented by `20261004120000_meal_planning_core.sql`: on `meal_plan`, `meal_plan_day`, `planned_meal`, `planned_meal_item` — SELECT for `full_management`, `view_only`, `pediatric_weight_management`; INSERT (and UPDATE on `meal_plan`/`planned_meal_item`) for `full_management` and `pediatric_weight_management`; no DELETE for anyone; direct owners resolve to `full_management`; revoked guardians and unrelated Accounts have no access. Nothing outside these four tables was broadened. Pediatric planning plans foods/recipes against existing targets only — no calorie formulas, deficits or advice. Plan adherence, nutrition adherence, goal progress and grocery remain future.

**Layer 8B:** `planned_actual_link` and `planned_meal_item_skip` (`20261005120000_planned_actual_links.sql`) follow the same shape — SELECT for `full_management`, `view_only`, `pediatric_weight_management`; INSERT and UPDATE (revocation only, trigger-enforced) for `full_management` and `pediatric_weight_management`; no DELETE; revoked guardians and unrelated Accounts see no rows and cannot insert. A pediatric_weight_management guardian can link/skip the authorized child's confirmed planned items against the child's own actual MealItems only. 7A MealLog/MealItem and 8A planning policies are unchanged. Plan adherence (as a score/metric) remains future; 8B only reports factual fulfillment states.

**Layer 9A:** `grocery_list`, `grocery_list_item`, `grocery_list_item_source` (`20261006120000_grocery_planning_core.sql`) implement the GroceryList part of this scope — SELECT for `full_management`, `view_only`, `pediatric_weight_management`; INSERT (generation) for `full_management` and `pediatric_weight_management`; no UPDATE/DELETE grants; revoked guardians and unrelated Accounts see no rows and cannot generate. A pediatric_weight_management guardian can preview and generate grocery requirements for the authorized child's active plans only; derivation is operational (no weight-loss advice, restriction logic, nutrition scoring or AI recommendations). User shopping state (GroceryListItem check-off, already-have, manual items) is Layer 9B and will need its own policies in the same shape.

**Layer 9B:** `grocery_manual_item`, `grocery_item_already_have`, `grocery_item_shopping_adjustment`, `grocery_purchase` (`20261007120000_grocery_shopping_state.sql`) — SELECT for `full_management`, `view_only`, `pediatric_weight_management`; INSERT and UPDATE (revocation only) for `full_management` and `pediatric_weight_management`; no DELETE; revoked guardians and unrelated Accounts see no rows and cannot write. A pediatric_weight_management guardian can run the authorized child's shopping workflow; it is operational only (no diet restriction, calorie advice, weight-loss recommendations or AI suggestions). 9A grocery permissions are unchanged.


When those modules exist, this scope is intended to extend to the authorized child's: MealPlan (read/write), planned meals (read/write), plan adherence (read), nutrition adherence (read), goal progress (read), GroceryList (read/write when related to the child's meal plan), GroceryListItem (read/write). No such table exists in Phase 1 — this is recorded now so the eventual module inherits the right access shape rather than defaulting to `full_management`-equivalent or no access.

### 9.2 Sensitive-domain exclusion

This scope must never automatically extend to: cycle data, pregnancy data, postpartum data, breastfeeding data, Account/security information, another guardian's private information, security/audit records, or any future sensitive-health module not listed above. None of the cycle/pregnancy/postpartum/breastfeeding entities exist in the Phase 1 schema yet (they remain deferred per `29_Data_Model_Data_Dictionary.md` §34); this exclusion is currently satisfied because there is nothing yet to restrict, and must be enforced explicitly — not assumed — when those tables are created.

### 9.3 Profile field-level privacy — pediatric API projection requirement

RLS controls rows, not columns. `profile`'s current column set (`id`, `account_id`, `display_name`, `is_child`, `date_of_birth`, `created_at`, `deleted_at`) is narrow enough that no field is itself the kind of "sensitive domain" data §9.2 excludes, but `account_id` (identifying the creating/primary guardian Account) is attribution about a *different party*, not information required for nutrition, growth, activity, or pediatric safety. Row-level security cannot withhold that single column while still allowing the row.

**Requirement for the future API/service layer:** a `pediatric_weight_management` caller's Profile read must be served through a projection/DTO — an explicit field allowlist in the API response, or a dedicated `security_barrier` view — exposing only fields required for nutrition, growth, activity, and pediatric safety. `account_id` must **not** be exposed through that projection. `created_at`/`deleted_at` must also remain internal unless a later requirement establishes a specific need for them. This is not implemented at the RLS layer in Phase 1; it is recorded here as a requirement for whichever later phase builds the API projection.

### 9.4 WearableConnection field-level privacy — pediatric API projection requirement

`pediatric_weight_management` holds row-level SELECT on `WearableConnection` (§ table above) so a guardian can see whether a supported wearable is connected, its provider, and safe status/last-sync information. The raw row may also carry internal integration metadata (e.g. `sync_cursor`, retry/error internals) that should not necessarily reach this scope through a client-facing API, even though RLS permits reading the row.

**Requirement for the future API/service layer:** the REST API must return a **safe pediatric WearableConnection projection/DTO**, not the raw row, to a `pediatric_weight_management` caller. That projection must **not** include: credentials, tokens, or secrets (none are modeled directly on this table today, but none must ever be added to it without re-reviewing this requirement); internal `sync_cursor` values; unnecessary provider identifiers beyond what identifies the connected service to the user; or internal error/debug information. No API implementation is required or performed in this RLS layer — this is a recorded requirement for whichever later phase builds that endpoint.

## 10. Platform administration & integrations (Phase 3 Layer 11C)

- **Separate from Profile authorization.** `platform_admin` comes only from an active PlatformRoleAssignment (`is_platform_admin()`); `profile_access_scope()` is unchanged, so Profile scopes never confer platform authority and `platform_admin` confers no Profile access (Profile routes stay `404` for an admin without a Profile relationship; tested). Role assignment has no client write path — trusted operators only. Revoked assignments grant nothing.
- **RLS.** ExternalProvider / ExternalProviderCapability: SELECT/INSERT/UPDATE only when `is_platform_admin()`; no DELETE (trigger). ProviderCapabilityDefinition: read-only vocabulary. Audit history and connection counts are SECURITY DEFINER functions that refuse non-admins; `audit_event` itself stays ungranted to clients. Non-admin server code reads routes only through `enabled_provider_routes()` (enabled rows; non-secret settings and the secret reference *name*; never a secret value, health or audit).
- **Secrets.** Never stored in the database or configuration: `secret_reference` is `env:NAME` (database-checked; other schemes need approval). Values are resolved in the API process at call time, passed to the adapter and never returned, logged or persisted; configuration keys that look like credentials are refused. The logger already redacts secret-like fields; tests assert no secret appears in any response or log line, including a provider error that embedded it. The mobile app never receives platform secrets; device-native frameworks use OS consent. User OAuth tokens are user-connection secrets and are not implemented yet (future additive extension of WearableConnection, same rules).
- **Audit.** Registration, enable/disable, configuration, priority, capability, secret-reference and health-check changes write AuditEvent through SECURITY DEFINER triggers (actor = `auth.uid()`; payload: provider key, field names, flags — no configuration values, secret references or secrets).
- **Privacy boundary.** Admin operational views expose aggregates only (active/failing user connection counts per wearable provider) — no Profile, Account, token, meal, weight, sleep or nutrition data. Looking at an individual's data needs a future, explicitly approved support/privacy workflow.
