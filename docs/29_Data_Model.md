# 29_Data_Model.md
# Phase 1 — Data Model

**Status:** Phase 1 specification — logical data model. No migrations exist yet; this document precedes and governs them.
**Authority:** Subordinate to `00_Master.md`. Where anything below appears to conflict with `00_Master.md`, the Master controls.
**Supersedes:** `DATABASE_SCHEMA.md`, `ENTITY_RELATIONSHIPS.md`, `DATA_DICTIONARY.md` (retained under `docs/fragments/` as historical source material only).

---

## 1. Purpose

This document defines the logical entities, relationships, and field-level requirements for Phase 1 of the platform: Account/Profile/session foundation, effective target resolution, meal lifecycle, recipe versioning/personalization, import ingestion, wearable sync, and the data-dictionary obligations (sensitivity/retention/validation/provenance) that apply across all of the above.

It does not yet define physical migrations, indexes, or RLS policy syntax. Those belong to implementation, gated on explicit approval per `00_Master.md` §27.4.

---

## 2. Core Entities (carried forward)

Account, AuthIdentity, DeviceSession, Profile, ChildProfileExtension, Goal, NutritionTarget, ClinicianTarget, WeightMeasurement, Food, FoodAlias, FoodServing, Nutrient, FoodNutrient, Product, Barcode, MealLog, MealItem, Recipe, RecipeIngredient, RecipeInstruction, RecipeCategory, RecipeTag, RecipeRating, RecipeVersion, UrlSource, RawContent, AiExtraction, WearableConnection, Activity, Workout, Sleep, Recovery, CycleRecord, PregnancyProfile, PostpartumProfile, BreastfeedingProfile, CoachRecommendation, NotificationPreference, AuditEvent.

These are unchanged in name/purpose from the earlier fragment inventory. Sections 3–11 below add the fields, states, and new entities required to close the gaps identified in the Phase 1 Architecture Review.

---

## 3. Meal Lifecycle

### 3.1 State field

`MealItem` (and, where a plan spans multiple items, `MealLog` at the aggregate level where applicable) carries an explicit `status` field:

```
status: draft | planned | confirmed | consumed | skipped | cancelled
```

Additional fields required to support the lifecycle:

- `confirmed_at` (timestamp, nullable) — set when status transitions to `confirmed`.
- `consumed_at` (timestamp, nullable) — set when status transitions to `consumed`.
- `status_changed_by` (reference to Account or `system`/`ai_optimizer`) — provenance of the last transition.

### 3.2 Transition rules

Allowed transitions:

- `draft → planned`
- `draft → cancelled`
- `planned → confirmed`
- `planned → cancelled` / `planned → skipped`
- `confirmed → consumed`
- `confirmed → cancelled` / `confirmed → skipped` (explicit user action only)
- `consumed → consumed` with an explicit **correction** (see 3.3) — never a bare overwrite.

No transition may move a `consumed` item back to `draft`, `planned`, or `confirmed`.

### 3.3 Protection rules

- `confirmed`: recipe, ingredients, serving size, scheduled time, and any user-entered nutrition values on the item are immutable except through explicit user acceptance of a proposed change. The coach/optimizer may attach a *suggestion* record (see `CoachRecommendation`) referencing the item; it may never mutate the item directly.
- `consumed`: immutable historical truth. The original row is never mutated in place. An explicit correction creates a **new** `MealItem` row with `status = consumed`, and:
  - the new row's `corrects_meal_item_id` (self-referencing FK, nullable) points back to the row it corrects;
  - the new row's `correction_reason` (required when `corrects_meal_item_id` is set) records why;
  - the original row gains `superseded_by_meal_item_id` (self-referencing FK, nullable), set at the same time, so the original remains queryable as historical fact while the current-truth view resolves to the latest row in the correction chain;
  - the correction action is also written to `AuditEvent` (actor, timestamp, before/after reference).
  A consumed item is never destructively edited; every correction is additive and traceable.

**Layer 8A amendment (authoritative).** Planned intent no longer uses MealItem: it lives in the separate planning domain (§3.5 below), where `PlannedMealItem` carries `draft → planned → confirmed` (or `cancelled`). `MealItem` is the actual-consumption record (`consumed` + corrections). The other MealItem enum values are retained, not removed (no destructive migration), and are unused by the official API. Master §6.6.

**Layer 7A (implemented).** Direct actual-consumption logging inserts items as `consumed` (with a server-calculated immutable nutrition snapshot) rather than walking `draft → planned → confirmed`; that path remains for planning. The correction above is one atomic operation (`correct_meal_item()`), and the AuditEvent is written by a database trigger on the supersession (see `30_API.md` §18). Removing/voiding a consumed item without a replacement is deferred.

### 3.4 Optimizer eligibility (data-model consequence)

Automatic optimizer/coach write access to `MealItem.status`-derived fields is limited to `draft` and `planned` states. Any service or AI agent writing to a `MealItem` must check `status` before applying an automatic change; this is a data-layer invariant, not only an application-layer convention, and should be enforced by a check/trigger where the target platform (Postgres) supports it.

### 3.5 Meal Planning domain (Phase 2 Layer 8A)

- `MealPlan` (Profile-owned): `name`, `description`, `start_date` ≤ `end_date`, `local_timezone` (IANA — planned dates and `scheduled_local_time` are local to it), `status`: `draft → active | cancelled`, `active → completed | cancelled`, `completed | cancelled → archived` (no automatic completion, no return to active).
- `MealPlanDay`: one per `(meal_plan_id, plan_date)`, inside the plan range.
- `PlannedMeal`: `meal_type` (the shared `meal_type` enum), optional `scheduled_local_time`, `notes`, `position`.
- `PlannedMealItem`: exactly one source — a Food (`food_id` + `quantity` + `unit` **or** `food_serving_id`) or an exact RecipeVersion (`recipe_id` + `recipe_version_id` + `quantity` = servings) of a recipe of the same Profile; `status` `draft | planned | confirmed | cancelled`; at confirmation an immutable server-computed `nutrition_snapshot` (+ `nutrition_calculation_version`, `nutrition_calculated_at`, `confirmed_at`); `supersedes_planned_meal_item_id` / `superseded_by_planned_meal_item_id` for accepted replacements.
- Confirmation state is per item; the only public confirmation today is whole-plan (`confirm_meal_plan()`), but nothing in the schema requires a plan's items to be confirmed together.
- Relationships: `Profile 1..N MealPlan 1..N MealPlanDay 1..N PlannedMeal 1..N PlannedMealItem`; composite `(id, profile_id)` keys keep every child in its plan's Profile. Planned intent is related to actual consumption only through §3.6 (Layer 8B), which leaves both records unchanged.

### 3.6 Planned vs actual (Phase 2 Layer 8B)

Two additive, Profile-owned relationship records; `PlannedMealItem` (8A) and `MealItem` (7A) are not modified and nothing is deleted. Fulfillment is **derived at read time**, never stored.

- `PlannedActualLink`: an explicit, user-asserted relation between a **current confirmed** `PlannedMealItem` and an **active** consumed `MealItem`, `relationship_type` `same_item` (same Food / exact RecipeVersion) or `substitution` (a different one). Active or revoked (`revoked_at`, `revoked_by_account_id`); revocation is the only change. The link keeps the MealItem id it was created with and records the root of that item's 7A correction chain (`meal_item_chain_root_id`); reads resolve the chain (`superseded_by_meal_item_id`) to the active record.
- `PlannedMealItemSkip`: "confirmed intent explicitly not consumed" — distinct from `PlannedMealItem.status = cancelled` (intent removed). Optional `reason`; active or revoked (unskip revokes).
- Database invariants (triggers serialized by transaction-scoped advisory locks — planned item first, then actual chain): at most one active skip per planned item; a planned item never has an active skip and an active link together; one actual correction chain actively links to at most one **current** planned item and at most once per planned item; the actual record is active and its `consumed_at`, converted to `MealPlan.local_timezone`, falls on `MealPlanDay.plan_date`; links/skips are created or revoked only on `active` or `completed` plans; composite `(id, profile_id)` keys keep every side in one Profile.
- Relationships: `PlannedMealItem 1..N PlannedActualLink N..1 MealItem`; `PlannedMealItem 1..N PlannedMealItemSkip` (at most one active).
- Derived fulfillment states: `unlinked`, `partial`, `fulfilled_exact`, `above_planned_quantity`, `fulfilled_with_substitution`, `skipped`, `quantity_not_comparable`, `identity_changed_by_correction` — computed from the confirmed planned `nutrition_snapshot` and the active actual snapshots only. No adherence score.

### 3.7 Grocery Planning (Phase 2 Layer 9A)

Persistent, immutable **generated** grocery artifacts derived from a MealPlan (Master §6.7). Three additive, Profile-owned tables; MealPlan, PlannedMealItem, links/skips, MealLog/MealItem, recipes and Food reference data are not modified.

- `GroceryList`: one **generation** of a plan's grocery requirements — `generation_number` 1..n per MealPlan, `status` `active | superseded` (exactly one active per plan), `supersedes_grocery_list_id` / `superseded_by_grocery_list_id`, the plan context at generation (status, date range, `local_timezone`), the **source fingerprint** and rule versions (`grocery-calculation-9a.1`, `grocery-source-fingerprint-9a.1`, `conversion-5a.1`), and the current plan items that were excluded (unconfirmed, pending replacement, skipped).
- `GroceryListItem`: a generated requirement — canonical Food (or none, for an unresolved Food), `dimension` `mass | volume | count` with its base unit `g | ml | count`, exact and rounded quantity, `resolution_status` (`resolved`, `incompatible_units`, `unresolved_quantity`, `ambiguous_unit`, `unresolved_conversion`, `unresolved_food`) and `aggregation_status`.
- `GroceryListItemSource`: traceability — one row per contributing planned Food item or scaled RecipeIngredient: MealPlan, MealPlanDay, PlannedMeal, PlannedMealItem, plan date, Food/serving, Recipe + exact RecipeVersion + RecipeIngredient, the stored amount, planned servings, yield, exact scale factor, scaled quantity, the contribution in the item's unit and the Layer 5A conversion steps/provenance.
- Relationships: `MealPlan 1..N GroceryList 1..N GroceryListItem 1..N GroceryListItemSource N..1 PlannedMealItem`; `GroceryList 0..1 → 0..1 GroceryList` (supersession chain). Composite `(id, profile_id)` keys keep every row, and every referenced plan row, in one Profile.
- Lifecycle: generated in one transaction (new generation inserted, previous active superseded) or not at all; afterwards sealed — no update (except the one-time supersession) and no delete. User shopping state is **not** stored here (Layer 9B extension point: separate tables referencing GroceryList/GroceryListItem).

### 3.8 Grocery workflow — user shopping state (Phase 2 Layer 9B)

User shopping facts in four additive, Profile-owned tables, each bound to ONE GroceryList generation (composite FKs `(grocery_list_id, profile_id)` → GroceryList and `(grocery_list_item_id, grocery_list_id)` → GroceryListItem, so state can only target an item of its own generation). The 9A tables are unchanged apart from one added unique key `grocery_list_item (id, grocery_list_id)`.

- `GroceryItemAlreadyHave` / `GroceryItemShoppingAdjustment`: a quantity + unit as entered, per generated item; at most one active each; setting a new value revokes the previous one.
- `GroceryPurchase`: purchase events for a generated item or a manual item (exactly one target) — quantity + unit, or neither (a check-off); many active; corrections revoke.
- `GroceryManualItem`: a user-added line on a generation — name, optional quantity + unit, optional Food, notes; removal revokes.
- All: `created_at`/`created_by_account_id`, `revoked_at`/`revoked_by_account_id`; revocation is the only change; no delete. Need-to-buy, target, purchased, remaining and statuses are derived at read time, never stored.
- Relationships: `GroceryList 1..N GroceryManualItem`; `GroceryListItem 1..N GroceryItemAlreadyHave / GroceryItemShoppingAdjustment / GroceryPurchase`; `GroceryManualItem 1..N GroceryPurchase`. No carry-forward between generations.

---

## 4. Effective Target Resolution

Per the approved design, this is **not** a continuously synchronized table. `EffectiveTargetResolver` is a deterministic service that computes the current effective target on demand from `Goal`, `NutritionTarget`, `ClinicianTarget`, and applicable safety/life-stage rules.

### 4.1 Resolver contract (data shape, not an endpoint definition — see `30_API.md`)

The resolver's output shape, per profile and per request, is:

- `profile_id`
- one entry per resolved field, keyed by canonical target key (Layer 7C: the Layer 5C nutrient key, e.g. `energy`, `protein`, `fiber`, `iron`; value in its reporting unit), each carrying:
  - `value`
  - `source`: `safety_rule | clinician_target | user_target | profile_derived`
  - `source_reference` (id of the contributing `ClinicianTarget`/`NutritionTarget`/`Goal` row, where applicable)
- `resolver_version` — the version of the resolution logic that produced this output.
- `resolved_at` — timestamp of computation.

This shape is not persisted by default. It is computed fresh on every read. Since Layer 7C the resolver also returns `unresolved_fields` — active target rows it could not interpret (pre-canonical names, incompatible units, conflicting rows) — rather than guessing (`30_API.md` §20).

### 4.2 Effective Target Snapshot (new entity: `EffectiveTargetSnapshot`)

Used only when historical reproducibility is required.

Fields:

- `id`
- `profile_id` — required; identifies whose resolved target this is.
- `snapshot_payload` — the full resolved-field-by-field output described in 4.1 (values + per-field `source`/`source_reference`), stored immutably at the time of creation.
- `resolver_version` — required.
- `resolved_at` — required; timestamp the resolution was computed.
- `snapshot_reason` — required; why the snapshot was created, e.g. `meal_consumed | daily_summary_finalized | coach_recommendation_issued | user_requested_export | manual_audit`.
- `linked_event_type` — nullable enum, `consumed_meal | daily_summary_finalized | coach_recommendation | other_auditable_decision`; null when the snapshot isn't anchored to one specific row (e.g. `user_requested_export`).
- `linked_event_id` — nullable; reference to the specific `MealItem`, `DailySummary` (Phase 3+ concept), `CoachRecommendation`, or other auditable row, when `linked_event_type` is set. Optional by design: a snapshot is valid without a single linked row.
- `created_at`

### 4.3 Immutability rule

`EffectiveTargetSnapshot` rows are write-once. A later change to `NutritionTarget`, `ClinicianTarget`, `Goal`, `Profile`, or a safety rule must never update or delete an existing snapshot. New snapshots are created for new events; history is never rewritten.

### 4.4 Ownership

No screen, module, or AI prompt computes an effective target independently. All consumers (Daily Tracker, Adaptive Nutrition Coach, Meal Planning, Analytics) call the single resolver.

### 4.5 Historical target context — daily snapshots (Phase 3 Layer 10A; resolves the Layer 7B gap)

`EffectiveTargetSnapshot` gains `local_date`, `local_timezone` (IANA), `unresolved_fields` and `created_by_account_id`, and the reason `daily_tracking`. A `daily_tracking` snapshot is the **one immutable target context for a Profile + local calendar date**: unique on `(profile_id, local_date)`; the first successful capture freezes the day (and its time zone); it can only be created for the current local date in its zone (API and database); its content is the single resolver's output (canonical 7C keys and units, field-level provenance incl. mixed clinician/user sources, resolver version, `resolved_at`) plus the resolver's unresolved fields. Target rows are append-only (supersession, no update/delete), but historical days are **not** reconstructed from them — a date without a daily snapshot has no historical target. The Daily Tracker uses the day's snapshot (today too), the live resolver only for today without one, and `historical_target_unavailable` otherwise. Capture: owners/full_management; view_only and pediatric_weight_management read only.

---

## 5. Clinician-Defined Targets

`ClinicianTarget` gains the following fields to satisfy Master §9's provenance requirement:

- `source_type`: `guardian_entered | user_entered | clinician_integration` (the last value reserved for a future direct-integration release; not used initially).
- `verification_status`: `unverified | platform_verified`. Initial implementation is expected to always be `unverified` unless/until a verified clinician-integration workflow exists — the field exists so the UI/data model never implies verification that didn't happen.
- `provided_by_account_id` — the Account (guardian/user) that entered the value.
- `entered_at`.

`ClinicianTarget` provenance must remain visibly distinct from `NutritionTarget` (ordinary user preference) at both the storage and resolver-output level (see §4.1's `source` enum).

---

## 6. Personalized Recipe Variants

### 6.1 Distinction

- **Base Recipe** (`Recipe`): the normalized recipe derived from a user-created or imported source.
- **Recipe Version** (`RecipeVersion`): revision history of the *base* recipe (canonical representation changes over time), independent of any individual profile.
- **Personalized Recipe Variant** (new entity: `RecipePersonalizedVariant`): a profile-specific derivative. Never a destructive edit of the base recipe or its versions.

### 6.2 `RecipePersonalizedVariant` fields

- `id`
- `base_recipe_id` (→ `Recipe`)
- `base_recipe_version_id` (→ `RecipeVersion`) — the specific version the variant was derived from.
- `profile_id` (→ `Profile`) — owner of the personalization.
- `adjustments_payload` — structured substitutions/portion/ingredient changes relative to the base version.
- `ai_generated` (boolean) — whether the adjustment originated from an AI suggestion.
- `source_confidence` (nullable) — present when `ai_generated` is true; see §9.
- `user_accepted_at` — timestamp of explicit user acceptance. A variant with material AI-generated changes and no `user_accepted_at` is not considered an approved personalization (Master §5, §11.3: AI output validated before persistence, explicit user acceptance required).
- `created_at`, `updated_at`.

### 6.3 `RecipeVersion` import provenance fields

To satisfy §7.4's traceability requirement, `RecipeVersion` carries:

- `origin_url_source_id` (nullable, → `UrlSource`) — null for a manually authored version.
- `origin_import_job_id` (nullable, → `ImportJob`) — the specific import operation that produced this version, when applicable.

### 6.4 Relationship consequence

`Recipe 1..N RecipeVersion` (unchanged). `Recipe 1..N RecipePersonalizedVariant` and `Profile 1..N RecipePersonalizedVariant` (new). Personalization never writes to `RawContent` or the base `Recipe`/`RecipeVersion` rows.

---

## 7. Import Idempotency and Deduplication

### 7.1 Finalized architecture: `UrlSource` and `ImportJob` are separate entities

**Approved decision — do not merge these entities during implementation.**

- `UrlSource` represents the persistent external source/resource identity. It exists once per distinct external resource, independent of how many times it has been fetched or processed.
- `ImportJob` represents one individual ingestion/processing operation performed against a `UrlSource` — an attempt, with its own outcome.
- Relationship: `UrlSource 1 → N ImportJob`.

This split is required so the platform can distinguish, per the same source: first import, retry, manual re-import, a changed external source, processing with a newer extraction/model version, a failed attempt, and a duplicate/idempotent request — none of which are representable if job state and source identity are the same row.

### 7.2 `UrlSource` fields

- `id`
- `canonical_url` — normalized form of the source URL. **Unique.**
- `original_url` — the URL as first submitted, prior to normalization (may differ from `canonical_url`).
- `source_provider` — `instagram | tiktok | youtube | web | manual`.
- `first_seen_at` — when this source was first submitted to the platform.
- `last_checked_at` — updated whenever any `ImportJob` attempts this source, regardless of outcome.
- `latest_content_fingerprint` — denormalized convenience copy of the most recent successful fetch's fingerprint; the authoritative per-attempt fingerprint always lives on the corresponding `ImportJob`/`RawContent`, not here.
- `created_at`.

### 7.3 `ImportJob` fields

- `id`
- `url_source_id` (→ `UrlSource`, required).
- `idempotency_key` — client- or system-supplied key identifying a logical import request. **Unique.**
- `trigger_type` — `initial_import | retry | manual_reimport | scheduled_recheck`.
- `requested_by_account_id` (nullable — null for a system-scheduled recheck).
- `requested_by_profile_id` (nullable, same rule).
- `content_fingerprint` — hash of the content fetched during *this* attempt (distinct from `UrlSource.latest_content_fingerprint`, which only mirrors the latest successful one).
- `extraction_model_version` (nullable until AI extraction runs for this job).
- `processing_status` — `queued | processing | needs_confirmation | succeeded | retryable_failed | permanently_failed | cancelled`. This is the canonical name/value set for import processing state across all Phase 1 documents.
- `retry_count`.
- `error_code` (nullable).
- `started_at`, `completed_at` (nullable).
- `created_at`, `updated_at`.

Index: `(url_source_id, created_at)` to retrieve a source's job history in order.

### 7.4 Linkage and traceability

- `RawContent` belongs to a specific `ImportJob` (`import_job_id`, required) — each processing attempt's raw fetch is its own row, never overwritten by a later attempt. A denormalized `url_source_id` is also carried on `RawContent` for query convenience.
- `AiExtraction 1..N` still belongs to `RawContent` (raw/normalized separation preserved per Master §5/§12), and additionally carries a denormalized `import_job_id` so extraction provenance doesn't depend on a multi-hop join.
- `AiExtraction` gains `extraction_method` and `model_version` fields (also required by §9 below).
- **The normalized result of an import retains explicit traceability back to both the source and the specific import/extraction operation, not only through the raw-content chain.** `RecipeVersion` (§6) carries `origin_url_source_id` and `origin_import_job_id` (both nullable — null for a manually authored version, populated for a version produced by an import), so a Recipe's provenance is queryable directly, without requiring a join through `AiExtraction → RawContent → ImportJob`.

### 7.5 Deduplication logic (data requirements, not implementation)

The model must be able to distinguish:

- the same `canonical_url` submitted twice → resolved via `UrlSource.canonical_url` lookup; a new `ImportJob` with `trigger_type = retry` or `manual_reimport` is created against the *existing* `UrlSource`, never a duplicate `UrlSource`. A resubmission carrying the same `idempotency_key` returns the existing `ImportJob`, not a new one.
- the same `content_fingerprint` appearing under a different `canonical_url` → a new `UrlSource` (distinct external resource), but linkable to the existing normalized `Recipe`/`RecipeVersion` where the platform can establish it's the same content, rather than blindly creating a duplicate `Recipe`.
- a genuine content update at an already-imported `canonical_url` → a new `ImportJob` (`trigger_type = scheduled_recheck` or `manual_reimport`) with a new `content_fingerprint`, producing new `RawContent`/`AiExtraction` rows and, where warranted, a new `RecipeVersion` — never a silent overwrite of the previous raw content or recipe version.

---

## 8. Wearable Synchronization Provenance

`WearableConnection`, `Activity`, `Workout`, `Sleep`, `Recovery` each gain:

- `provider_record_id` — the source system's identifier for this record, used for idempotent upsert.
- `provenance`: `wearable_direct | wearable_derived | user_override`.
- `synced_at`.

`WearableConnection` additionally gains:

- `sync_cursor` / `sync_checkpoint` — opaque provider-specific checkpoint enabling incremental sync.
- `last_sync_status`: `success | partial | retryable_failure | permanent_failure`.
- `retry_count`.

Upserts on `Activity`/`Workout`/`Sleep`/`Recovery` are keyed on `(wearable_connection_id, provider_record_id)` to guarantee idempotency per Master §17 and the NFR reliability requirement (no duplicate workouts).

---

## 9. AI Extraction Confidence and Provenance

Applies to `AiExtraction` and any other entity that stores an AI-derived structured value (e.g. `RecipePersonalizedVariant.adjustments_payload`, food-match proposals consumed by Multimodal Food Logging in a later phase).

Required fields wherever an AI-derived value is persisted:

- `source` — what was interpreted (e.g. `photo | voice_transcript | url_import | barcode_lookup_ambiguity`).
- `extraction_method` — model/prompt/pipeline identifier.
- `model_version`.
- `confidence` (numeric or banded).
- `status` — `success | partial_success | needs_confirmation | retryable_failure | permanent_failure` (Master §18's minimum status set; `needs_confirmation` naming kept consistent with `ImportJob.processing_status`'s `needs_confirmation` value, §7.3).
- `created_at`.

A value with `status = needs_confirmation` or low `confidence` must not be treated as authoritative by any deterministic calculation until confirmed (Master §16, §18).

---

## 10. Localization / Internationalization

- `Food` and `Nutrient` remain language-independent canonical entities — no locale field, no per-language duplication.
- `FoodAlias` gains `locale` (BCP 47, e.g. `en`, `en-AE`, `ar-AE`) — a `Food` may have multiple aliases across locales; alias lookup/search is locale-aware.
- `FoodServing` gains an optional `region` (BCP 47 region/market subtag, nullable) for serving descriptions that vary by market (e.g. a "cup" convention that differs regionally). The underlying normalized quantity on `FoodServing` always uses a canonical deterministic unit regardless of region.
- **Implemented (Phase 2 Layer 5A):** locale lookup follows BCP 47 truncation then the platform default `en` (`ar-AE` → `ar` → `en`); search matches aliases in every locale and ranks the caller's chain first, with `canonical_name` as a lower-ranked fallback that is never shown as a display label; `FoodServing.canonical_unit` is restricted to `g`/`ml`; `FoodServing.serving_description` has no `locale` column, so serving text is returned as stored — serving localization is deferred (see `30_API.md` §14, final architecture decisions).
- Nutrient *display* labels are localization/display data, not separate `Nutrient` rows — modeled as a lookup keyed by `(nutrient_id, locale)`, not a new nutrient identity per language.
- Any raw user- or source-provided text (e.g. an ingredient line from an import) is retained on `RawContent`/`AiExtraction` in its original language, separate from the normalized `FoodAlias`/`Food` match it resolves to.

---

## 11. Guardian Authorization for Child Profiles

### 11.1 New entity: `GuardianAuthorization`

- `id`
- `guardian_account_id` (→ `Account`) — the Account being granted access.
- `child_profile_id` (→ `Profile`, where `Profile.is_child = true` via `ChildProfileExtension`).
- `authorization_scope` — `full_management | pediatric_weight_management | view_only`. This is the Phase 1 fixed starting enum; `19_Family_and_Multi_Profile.md` / `21_Pediatric_Weight_Management.md` may propose additional scope values in a later phase, but must not repurpose or redefine these three.
- `granted_by_account_id` (→ `Account`) — the Account that performed the grant (typically the guardian themself in the initial self-serve flow; kept distinct from `guardian_account_id` so a future co-guardian/administrative grant is representable without a schema change).
- `consented_at` — required.
- `revoked_at` (nullable) — null means active; set means revoked.
- `revoked_by_account_id` (nullable, → `Account`) — required when `revoked_at` is set.

### 11.2 Relationship consequence

This is distinct from ordinary `Account 1..N Profile` ownership: a child `Profile` is accessed *through* an authorized guardian `Account` via `GuardianAuthorization`, not through the child holding its own `AuthIdentity` (Master §7.4 — no independent child authentication). Every server-side authorization check for a child profile must resolve through `GuardianAuthorization`, not assume implicit ownership.

This entity is also the join point RLS policies will use for guardian→child isolation (see `33_Security_and_Privacy.md` §Authorization Model).

---

## 12. Data Dictionary Obligations

Every entity and field introduced or modified above — and, before migrations are written, every existing entity/field in the Phase 1 scope — must be documented with:

- `type`
- `nullability`
- `source` (user-entered / AI-derived / imported / system-computed / third-party)
- `PII/health classification` (`none | pii | health | child_pii | child_health`)
- `retention rule` (reference to the category rules in `00_Master.md` §14 and `33_Security_and_Privacy.md`)
- `validation rule` (reference to the runtime schema, e.g. Zod, that enforces it at the API boundary)

This table is not fully populated in this document; producing it is the immediate next step before migrations (see Recommended Implementation Order in the Phase 1 Architecture Review). At minimum, the following categories are pre-classified here because they gate RLS/retention design:

| Entity | Classification | Retention anchor |
|---|---|---|
| `Account`, `AuthIdentity`, `DeviceSession` | PII | Master §14.1 |
| `Profile` (adult) | PII | Master §14.1 |
| `Profile` (child) / `ChildProfileExtension` / `GuardianAuthorization` | Child PII | Master §14.3 |
| `WeightMeasurement`, `ClinicianTarget`, `PregnancyProfile`, `PostpartumProfile`, `BreastfeedingProfile`, `CycleRecord` | Health | Master §15 |
| `WeightMeasurement` on a child `Profile` | Child Health | Master §10.2, §14.3 |
| `MealLog`, `MealItem`, `EffectiveTargetSnapshot` | Health (nutrition history) | Master §14.2 |
| `RawContent` | Operational/provenance, not archival | Master §14.4 |
| `AuditEvent` | Operational | Master §14.5 (logs must exclude sensitive payload content) |

---

## 13. New Entities Introduced by This Document

- `EffectiveTargetSnapshot`
- `RecipePersonalizedVariant`
- `ImportJob`
- `GuardianAuthorization`

## 14. Existing Entities Modified by This Document

- `MealItem` — `status`, `confirmed_at`, `consumed_at`, `status_changed_by`, `corrects_meal_item_id`, `superseded_by_meal_item_id`, `correction_reason`.
- `ClinicianTarget` — `source_type`, `verification_status`, `provided_by_account_id`, `entered_at`.
- `AiExtraction` — `extraction_method`, `model_version`, `status`, `import_job_id` (denormalized).
- `WearableConnection`, `Activity`, `Workout`, `Sleep`, `Recovery` — `provider_record_id`, `provenance`, `synced_at`; `WearableConnection` additionally `sync_cursor`, `last_sync_status`, `retry_count`.
- `FoodAlias` — `locale`.
- `FoodServing` — `region` (nullable).
- `Food` — `density_g_per_ml`, `density_source` (both nullable, paired; Phase 2 Layer 5A).
- `FoodNutrient` — `basis_quantity`, `basis_unit` (Phase 2 Layer 5A).
- `Nutrient` — `role` (Phase 2 Layer 5C); canonical vocabulary seeded. `FoodServing.source` and `Food.density_source` may no longer be `user_entered` (Layer 5C — personal data never enters global reference tables). `FoodNutrient.source` may only be `trusted_database` or `manufacturer_label` for new/updated rows — FoodNutrient is global/reference nutrition data; personal user-entered nutrition and AI estimates are not stored there (Layer 5C final boundary; constraint `NOT VALID`, historical rows retained for review).
- `UrlSource` — `canonical_url`, `original_url`, `source_provider`, `first_seen_at`, `last_checked_at`, `latest_content_fingerprint` (finalized per §7.2; `UrlSource 1 → N ImportJob`).
- `RawContent` — `import_job_id` (required), `url_source_id` (denormalized).
- `RecipeVersion` — `origin_url_source_id`, `origin_import_job_id` (both nullable).
- `MealLog` — `local_timezone` (IANA), `notes` (Phase 2 Layer 7A).
- New Phase 2 Layer 8A entities: `MealPlan`, `MealPlanDay`, `PlannedMeal`, `PlannedMealItem` (§3.5); `RecipeVersion` gains unique `(id, recipe_id)` as a composite FK target.
- New Phase 2 Layer 8B entities: `PlannedActualLink`, `PlannedMealItemSkip` (§3.6); `PlannedMealItem` and `MealItem` each gain unique `(id, profile_id)` as composite FK targets (no column or behaviour change).
- New Phase 2 Layer 9A entities: `GroceryList`, `GroceryListItem`, `GroceryListItemSource` (§3.7). No existing entity is modified.
- New Phase 2 Layer 9B entities: `GroceryManualItem`, `GroceryItemAlreadyHave`, `GroceryItemShoppingAdjustment`, `GroceryPurchase` (§3.8); `GroceryListItem` gains unique `(id, grocery_list_id)` as a composite FK target (no column or behaviour change).
- `EffectiveTargetSnapshot` — `local_date`, `local_timezone`, `unresolved_fields`, `created_by_account_id` (all nullable; required for reason `daily_tracking`), reason `daily_tracking`, unique daily index (Phase 3 Layer 10A, §4.5).
- `MealItem` — `unit`, `nutrition_snapshot`, `nutrition_calculation_version`, `nutrition_calculated_at`; Food-vs-Recipe invariant; `(meal_log_id, profile_id)` FK; same-Profile recipe rule (Phase 2 Layer 7A).
- `RecipeIngredient` — `food_serving_id` (nullable; must belong to the ingredient's Food; exclusive with `unit`) (Phase 2 Layer 6A). `Recipe.current_version_id` must reference a version of the same Recipe (trigger), and a new version with its ingredients/instructions is written atomically by `create_recipe_version()` (SECURITY INVOKER, existing RLS).

## 15. Full Field-Level Data Dictionary

The exhaustive field-level Data Dictionary (type, nullability, default, key relationships, source, validation, editability, PII/health/child classification, retention, deletion, export, provenance, audit, indexes) for every Phase 1 entity is maintained in a companion document: **`29_Data_Model_Data_Dictionary.md`**. That document is normative for field-level detail; this document remains normative for entity shape, relationships, and lifecycle/state-machine rules.
