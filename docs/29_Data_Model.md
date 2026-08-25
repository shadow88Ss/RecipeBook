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
- `consumed`: immutable historical truth. The only permitted mutation path is an explicit correction flow that writes a new value while preserving the prior value and actor in an audit trail (`AuditEvent`, or a `MealItemCorrection` history row — implementation detail for Phase 2/3, but the data model must not allow destructive in-place edits to a consumed item's core nutrition fields).

### 3.4 Optimizer eligibility (data-model consequence)

Automatic optimizer/coach write access to `MealItem.status`-derived fields is limited to `draft` and `planned` states. Any service or AI agent writing to a `MealItem` must check `status` before applying an automatic change; this is a data-layer invariant, not only an application-layer convention, and should be enforced by a check/trigger where the target platform (Postgres) supports it.

---

## 4. Effective Target Resolution

Per the approved design, this is **not** a continuously synchronized table. `EffectiveTargetResolver` is a deterministic service that computes the current effective target on demand from `Goal`, `NutritionTarget`, `ClinicianTarget`, and applicable safety/life-stage rules.

### 4.1 Resolver contract (data shape, not an endpoint definition — see `30_API.md`)

The resolver's output shape, per profile and per request, is:

- `profile_id`
- one entry per resolved field (e.g. `calories`, `protein_g`, `fiber_g`, ...), each carrying:
  - `value`
  - `source`: `safety_rule | clinician_target | user_target | profile_derived`
  - `source_reference` (id of the contributing `ClinicianTarget`/`NutritionTarget`/`Goal` row, where applicable)
- `resolver_version` — the version of the resolution logic that produced this output.
- `resolved_at` — timestamp of computation.

This shape is not persisted by default. It is computed fresh on every read.

### 4.2 Effective Target Snapshot (new entity: `EffectiveTargetSnapshot`)

Used only when historical reproducibility is required.

Fields:

- `id`
- `profile_id`
- `snapshot_payload` — the full resolved-field-by-field output described in 4.1, stored immutably at the time of creation.
- `resolver_version`
- `resolved_at`
- `linked_event_type`: `consumed_meal | daily_summary_finalized | coach_recommendation | other_auditable_decision`
- `linked_event_id` — reference to the specific `MealItem`, `DailySummary` (Phase 3+ concept), `CoachRecommendation`, or other auditable row that triggered the snapshot.
- `created_at`

### 4.3 Immutability rule

`EffectiveTargetSnapshot` rows are write-once. A later change to `NutritionTarget`, `ClinicianTarget`, `Goal`, `Profile`, or a safety rule must never update or delete an existing snapshot. New snapshots are created for new events; history is never rewritten.

### 4.4 Ownership

No screen, module, or AI prompt computes an effective target independently. All consumers (Daily Tracker, Adaptive Nutrition Coach, Meal Planning, Analytics) call the single resolver.

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

### 6.3 Relationship consequence

`Recipe 1..N RecipeVersion` (unchanged). `Recipe 1..N RecipePersonalizedVariant` and `Profile 1..N RecipePersonalizedVariant` (new). Personalization never writes to `RawContent` or the base `Recipe`/`RecipeVersion` rows.

---

## 7. Import Idempotency and Deduplication

### 7.1 New entity: `ImportJob`

- `id`
- `idempotency_key` — client- or system-supplied key identifying a logical import request.
- `source_provider` — e.g. `instagram | tiktok | youtube | web | manual`.
- `canonical_url` — normalized/canonicalized form of the source URL (distinct from the raw submitted URL).
- `content_fingerprint` — hash of the fetched raw content, used to detect the same content republished at a different URL.
- `processing_status`: `queued | processing | needs_confirmation | succeeded | failed_retryable | failed_permanent`.
- `retry_count`.
- `created_at`, `updated_at`.

### 7.2 Linkage

- `UrlSource` references the originating `ImportJob` (or `ImportJob` supersedes `UrlSource` as the job-tracking entity, with `UrlSource` retained specifically as the durable record of the source URL identity — exact table consolidation is an implementation-time decision, not a Phase 1 blocker, provided both the idempotency-key/job-status concept and the source-identity concept are represented).
- `RawContent 1..N` still belongs to a `UrlSource`/`ImportJob`; `AiExtraction 1..N` still belongs to `RawContent` (raw/normalized separation preserved per Master §5/§12).
- `AiExtraction` gains `extraction_method` and `model_version` fields (also required by §9 below).

### 7.3 Deduplication logic (data requirements, not implementation)

The model must be able to distinguish:

- the same `canonical_url` submitted twice → resolve via `idempotency_key`/`canonical_url` lookup, no duplicate `ImportJob`.
- the same `content_fingerprint` at a different `canonical_url` → new `UrlSource`, but linkable to the existing normalized `Recipe`/extraction where the platform can establish it's the same content, rather than blindly creating a duplicate `Recipe`.
- a genuine content update at an already-imported `canonical_url` → new `ImportJob`/`RawContent` version, not a silent overwrite of the previous raw content (raw content itself is never mutated in place — a new row is added and the prior one retained per its retention rule, §11).

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
- `status`: `success | partial_success | needs_user_confirmation | retryable_failure | permanent_failure` (Master §18's minimum status set).
- `created_at`.

A value with `status = needs_user_confirmation` or low `confidence` must not be treated as authoritative by any deterministic calculation until confirmed (Master §16, §18).

---

## 10. Localization / Internationalization

- `Food` and `Nutrient` remain language-independent canonical entities — no locale field, no per-language duplication.
- `FoodAlias` gains `locale` (BCP 47, e.g. `en`, `en-AE`, `ar-AE`) — a `Food` may have multiple aliases across locales; alias lookup/search is locale-aware.
- `FoodServing` gains an optional `region` (BCP 47 region/market subtag, nullable) for serving descriptions that vary by market (e.g. a "cup" convention that differs regionally). The underlying normalized quantity on `FoodServing` always uses a canonical deterministic unit regardless of region.
- Nutrient *display* labels are localization/display data, not separate `Nutrient` rows — modeled as a lookup keyed by `(nutrient_id, locale)`, not a new nutrient identity per language.
- Any raw user- or source-provided text (e.g. an ingredient line from an import) is retained on `RawContent`/`AiExtraction` in its original language, separate from the normalized `FoodAlias`/`Food` match it resolves to.

---

## 11. Guardian Authorization for Child Profiles

### 11.1 New entity: `GuardianAuthorization`

- `id`
- `guardian_account_id` (→ `Account`)
- `child_profile_id` (→ `Profile`, where `Profile.is_child = true` via `ChildProfileExtension`)
- `authorization_scope` — e.g. `full_management | specific_feature_grants` (exact grant taxonomy belongs to `19_Family_and_Multi_Profile.md` / `21_Pediatric_Weight_Management.md`; Phase 1 only needs the entity to exist and be authorizable/revocable).
- `consented_at`
- `revoked_at` (nullable)

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

- `MealItem` — `status`, `confirmed_at`, `consumed_at`, `status_changed_by`.
- `ClinicianTarget` — `source_type`, `verification_status`, `provided_by_account_id`, `entered_at`.
- `AiExtraction` — `extraction_method`, `model_version`, `status` (confidence already implied, now explicit).
- `WearableConnection`, `Activity`, `Workout`, `Sleep`, `Recovery` — `provider_record_id`, `provenance`, `synced_at`; `WearableConnection` additionally `sync_cursor`, `last_sync_status`, `retry_count`.
- `FoodAlias` — `locale`.
- `FoodServing` — `region` (nullable).
- `UrlSource` — linkage to `ImportJob`.
