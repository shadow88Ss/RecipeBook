# 29_Data_Model_Data_Dictionary.md
# Phase 1 — Data Dictionary (Field-Level)

**Status:** Phase 1 specification — exhaustive field-level detail. Companion to `29_Data_Model.md`, which remains normative for entity shape, relationships, and lifecycle rules. No migrations exist yet.
**Authority:** Subordinate to `00_Master.md` and `29_Data_Model.md`.

---

## 0. Conventions Used in This Document

To keep 33 entities' worth of field-level detail tractable, classification/retention/deletion/export/audit are documented **once per entity** as defaults, with field-level exceptions called out explicitly where a field's handling differs from its entity's default. This satisfies the per-field documentation requirement by inheritance plus explicit override, rather than repeating identical values on every row of every table.

Each entity section states:
- **Purpose** — one line.
- **PII** — yes/no.
- **Health** — yes/no.
- **Child-sensitive** — yes / no / conditional (depends on whether the linked Profile is a child profile).
- **Retention category** — reference to `00_Master.md` §14 / `33_Security_and_Privacy.md` §4.
- **Deletion behavior** — entity-level default.
- **Export behavior** — entity-level default.
- **Audit requirement** — entity-level default.

Then a field table with columns:

`Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes (provenance / classification override / index)`

"Source" values used throughout: `user_entered`, `guardian_entered`, `system_computed`, `ai_derived`, `synced_external` (wearable/third-party), `trusted_database`, `manufacturer_label`.

---

## 1. Account

**Purpose:** the authenticated security principal; app-level mirror of the Supabase Auth user.
**PII:** yes. **Health:** no. **Child-sensitive:** no — Accounts belong only to adults/guardians (Master §7.4).
**Retention:** Master §14.1 — while active. **Deletion:** delete or irreversibly anonymize on verified request, except where legally required to retain. **Export:** included in account export. **Audit:** creation and deletion/anonymization logged to `AuditEvent`.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK, = Supabase `auth.users.id` | synced_external | must reference an existing Supabase Auth user | no | unique |
| email | text | nullable (Apple private relay/edge cases) | — | — | synced_external | email format | no (edited via Supabase Auth flow) | **not unique** (Layer 3 correction: two distinct Supabase Auth users may share an email — e.g. Supabase's automatic-linking setting left off per `37_Authentication_and_Login.md` §7/§11 — and must remain two distinct Accounts, never auto-merged); PII |
| display_name | text | nullable | — | — | user_entered | length/profanity per app rules | yes | PII |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |
| deleted_at | timestamp | nullable | null | — | system_computed | — | no | set on verified deletion/anonymization |

---

## 2. AuthIdentity

**Purpose:** a linked provider identity (Apple / Google / email) for an Account.
**PII:** yes. **Health:** no. **Child-sensitive:** no.
**Retention:** Master §14.1. **Deletion:** removed with Account, or on explicit unlink. **Export:** included. **Audit:** link/unlink events logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| account_id | uuid | not null | — | FK → Account | system_computed | must reference existing Account | no | index |
| provider | enum(`apple`,`google`,`email`) | not null | — | — | synced_external | fixed set | no | — |
| provider_subject_id | text | not null | — | — | synced_external | provider-verified identity, never accepted from client without provider proof | no | unique on (provider, provider_subject_id) |
| linked_at | timestamp | not null | now() | — | system_computed | — | no | — |
| unlinked_at | timestamp | nullable | null | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 3. DeviceSession

**Purpose:** application-level device/session metadata and revocation (not a token authority — Master §7.2).
**PII:** yes. **Health:** no. **Child-sensitive:** no.
**Retention:** Master §14.1. **Deletion:** removed with Account. **Export:** not included (operational). **Audit:** revocation events logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| account_id | uuid | not null | — | FK → Account | system_computed | — | no | index |
| device_name | text | nullable | — | — | user_entered | length limit | yes | label only |
| device_type | enum(`ios`,`android`) | nullable | — | — | system_computed | — | no | — |
| supabase_session_reference | text | not null | — | — | synced_external | opaque reference; never the raw token | no | never exposed in export/logs |
| biometric_enabled | boolean | not null | false | — | user_entered | — | yes | device-local enablement flag only |
| trusted | boolean | not null | false | — | system_computed | — | no | — |
| last_active_at | timestamp | nullable | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |
| revoked_at | timestamp | nullable | null | — | user_entered / system_computed | — | yes (user-initiated revoke) | logout / logout-all / lost-device / security revocation |
| revoked_reason | enum(`user_logout`,`user_logout_all`,`lost_device`,`security_revocation`) | nullable | null | — | system_computed | required if revoked_at set | no | — |

Index: `(account_id, revoked_at)`.

---

## 4. Profile

**Purpose:** whose nutrition context is being accessed; owned by an Account, optionally guardian-managed if a child profile.
**PII:** yes (adult) — see Child-sensitive override below. **Health:** no (health data lives in child entities). **Child-sensitive:** conditional — Child PII when `is_child = true`.
**Retention:** Master §14.1 (adult) / §14.3 (child, stricter). **Deletion:** with verified account/profile deletion request. **Export:** included. **Audit:** creation/deletion logged; child-profile creation additionally logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| account_id | uuid | not null | — | FK → Account | system_computed | the creating/primary guardian Account for a child profile | no | index |
| display_name | text | not null | — | — | user_entered / guardian_entered | length | yes | — |
| is_child | boolean | not null | false | — | user_entered / guardian_entered | immutable after creation | no (set once at creation) | — |
| date_of_birth | date | nullable | — | — | user_entered / guardian_entered | required if `is_child = true` | yes (guardian only, if child) | Child PII when `is_child = true`; else PII |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |
| deleted_at | timestamp | nullable | null | — | system_computed | — | no | — |

---

## 5. ChildProfileExtension

**Purpose:** pediatric-specific extension attached 1:1 to a child Profile.
**PII:** Child PII. **Health:** Child Health (workflow-adjacent). **Child-sensitive:** yes, always.
**Retention:** Master §14.3 — stricter minimization, no indefinite retention for analytics. **Deletion:** with Profile deletion. **Export:** guardian-initiated only. **Audit:** enable/disable of pediatric workflow logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| profile_id | uuid | not null | — | PK, FK → Profile (1:1) | system_computed | must reference a Profile with `is_child = true` | no | unique |
| guardian_pediatric_workflow_enabled | boolean | not null | false | — | guardian_entered | requires active `GuardianAuthorization` with `authorization_scope = pediatric_weight_management` | yes (guardian only) | Master §10.2 carve-out gate |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 6. GuardianAuthorization

**Purpose:** the authorization/consent record governing a guardian Account's access to a child Profile (Master §7.4).
**PII:** Child PII. **Health:** no (access grant, not health data itself). **Child-sensitive:** yes, always.
**Retention:** Master §14.3. **Deletion:** not user-deletable directly — revoked, not removed; retained as an audit record even after revocation, deleted only with full child-profile deletion. **Export:** guardian's own grants included in their export. **Audit:** this entity is itself largely an audit record; grant and revoke are always logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| guardian_account_id | uuid | not null | — | FK → Account | system_computed | — | no | index |
| child_profile_id | uuid | not null | — | FK → Profile | system_computed | must reference `is_child = true` Profile | no | index |
| authorization_scope | enum(`full_management`,`pediatric_weight_management`,`view_only`) | not null | — | — | guardian_entered | fixed Phase 1 set (§29_Data_Model.md §11) | yes (grant-time; changing scope creates a new grant, not an in-place edit) | do not repurpose these three values |
| granted_by_account_id | uuid | not null | — | FK → Account | system_computed | — | no | distinct from `guardian_account_id` for future co-guardian/admin grants |
| consented_at | timestamp | not null | — | — | guardian_entered | — | no | — |
| revoked_at | timestamp | nullable | null | — | user_entered / system_computed | — | yes (revoke action) | null = active |
| revoked_by_account_id | uuid | nullable | null | — | system_computed | required if `revoked_at` set | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Constraint: at most one active (`revoked_at IS NULL`) row per `(guardian_account_id, child_profile_id)`.

---

## 7. Goal

**Purpose:** user-defined high-level nutrition/weight goal.
**PII:** no. **Health:** yes. **Child-sensitive:** conditional (Child Health if owning Profile `is_child`).
**Retention:** profile-active. **Deletion:** with Profile. **Export:** included. **Audit:** none beyond standard timestamps.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| profile_id | uuid | not null | — | FK → Profile | system_computed | — | no | index |
| goal_type | enum(`weight_loss`,`maintenance`,`weight_gain`,`micronutrient_improvement`,`fiber_improvement`,`other`) | not null | — | — | user_entered / guardian_entered | fixed set; a pediatric safe subset is intended per Master §10.3, but Master §10.3 currently states only qualitative product principles, not a concrete subset of these six values — **not yet enforced** (Layer 4B API Report, "Deferred/specification gaps"); all six remain selectable for a child profile until an approved specification defines the subset | yes | — |
| target_weight_kg | numeric | nullable | — | — | user_entered | positive, plausible range | yes | — |
| target_date | date | nullable | — | — | user_entered | future date | yes | — |
| notes | text | nullable | — | — | user_entered | length limit | yes | — |
| is_active | boolean | not null | true | — | user_entered | — | yes | — |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 8. NutritionTarget

**Purpose:** explicit user-defined target value for a single resolvable field (field-by-field, per Master §8.1 — not a wide single-row object).
**PII:** no. **Health:** yes. **Child-sensitive:** conditional.
**Retention:** profile-active. **Deletion:** with Profile. **Export:** included. **Audit:** none beyond the non-destructive supersede pattern below.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| profile_id | uuid | not null | — | FK → Profile | system_computed | — | no | index |
| field_name | text | not null | — | — | system_computed | a canonical target key = a Layer 5C `nutrient.canonical_key` (`energy`, `protein`, `fiber`, `iron`, ...) for rows written since Layer 7C (`enforce_canonical_target`); input aliases (`calories`, `protein_g`, `carbs`, ...) are normalized by the API, never stored | no | shared vocabulary with `ClinicianTarget.field_name`; pre-7C rows keep their stored name and are interpreted/reported by the resolver (`30_API.md` §20) |
| value | numeric | not null | — | — | user_entered | plausible range per field | yes | — |
| unit | text | not null | — | — | user_entered | the key's reporting unit exactly (kcal / g / mg / mcg); the API converts compatible mass units exactly and rejects kJ, IU and mass↔energy | yes | Layer 7C |
| is_active | boolean | not null | true | — | system_computed | — | no (managed by supersede pattern) | — |
| superseded_at | timestamp | nullable | null | — | system_computed | — | no | set when a newer row for the same field is created; old row retained for history |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

Constraint: at most one row with `is_active = true` per `(profile_id, field_name)`.

---

## 9. ClinicianTarget

**Purpose:** clinician-provenanced target value for a single resolvable field (Master §9).
**PII:** no. **Health:** yes. **Child-sensitive:** conditional (Child Health if owning Profile `is_child`).
**Retention:** profile-active, stricter if child. **Deletion:** with Profile. **Export:** included. **Audit:** creation logged to `AuditEvent` (clinical-safety sensitivity).

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| profile_id | uuid | not null | — | FK → Profile | system_computed | — | no | index |
| field_name | text | not null | — | — | system_computed | shared vocabulary with `NutritionTarget.field_name`: canonical target key only for rows since Layer 7C | no | — |
| value | numeric | not null | — | — | guardian_entered / user_entered | plausible/safety-bounded range | yes | — |
| unit | text | not null | — | — | guardian_entered / user_entered | the key's reporting unit exactly (Layer 7C) | yes | — |
| source_type | enum(`guardian_entered`,`user_entered`,`clinician_integration`) | not null | — | — | system_computed | `clinician_integration` reserved, unused in Phase 1 | no | — |
| verification_status | enum(`unverified`,`platform_verified`) | not null | `unverified` | — | system_computed | never set to `platform_verified` without an approved verified-integration workflow | no | UI must not imply verification that didn't happen (Master §9) |
| provided_by_account_id | uuid | not null | — | FK → Account | system_computed | — | no | — |
| entered_at | timestamp | not null | — | — | system_computed | — | no | — |
| is_active | boolean | not null | true | — | system_computed | — | no | — |
| superseded_at | timestamp | nullable | null | — | system_computed | — | no | same supersede pattern as `NutritionTarget` |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Constraint: at most one row with `is_active = true` per `(profile_id, field_name)`.

---

## 10. WeightMeasurement

**Purpose:** a single weight measurement for a Profile.
**PII:** no. **Health:** yes. **Child-sensitive:** conditional — Child Health, and specifically the pediatric weight-management carve-out data (Master §10.2) when owning Profile `is_child`.
**Retention:** profile-active, stricter if child. **Deletion:** with Profile. **Export:** included. **Audit:** required for child-profile rows.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| profile_id | uuid | not null | — | FK → Profile | system_computed | — | no | index |
| measured_at | timestamp | not null | — | — | user_entered / synced_external | not future-dated | no (immutable historical fact — see correction pattern) | — |
| value_kg | numeric | not null | — | — | user_entered / synced_external / guardian_entered | positive, plausible range | no (correction only) | — |
| source | enum(`user_entered`,`wearable_synced`,`clinician_entered`) | not null | — | — | system_computed | fixed set | no | — |
| provenance_reference | uuid | nullable | — | — | system_computed | e.g. `WearableConnection.id` when `source = wearable_synced` | no | — |
| corrects_measurement_id | uuid | nullable | null | self-FK → WeightMeasurement | system_computed | — | no | correction pattern, mirrors `MealItem`. Layer 10B reading rule: the active measurement is the row no other row corrects (A → B → C: C). Unique where not null (`uq_weight_measurement_single_correction`, Layer 10B closure): at most one direct correction per measurement, so corrections form a single chain; a second direct correction is refused (API `409`). A legacy branch predating the invariant is treated as a conflict (all its rows excluded from progress), never resolved by picking one |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 11. EffectiveTargetSnapshot

**Purpose:** immutable historical record of a resolved effective target, anchored to an auditable event (per approved design — never the current source of truth).
**PII:** no. **Health:** yes. **Child-sensitive:** conditional.
**Retention:** Master §14.2 (nutrition-history category). **Deletion:** with Profile. **Export:** included (reproducibility on request). **Audit:** creation is itself audit-grade; no update/delete permitted, ever.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| profile_id | uuid | not null | — | FK → Profile | system_computed | — | no | index |
| snapshot_payload | jsonb | not null | — | — | system_computed | must match `EffectiveTargetResolver` output shape (`29_Data_Model.md` §4.1) | no | field-by-field value + source + source_reference |
| resolver_version | text | not null | — | — | system_computed | — | no | — |
| resolved_at | timestamp | not null | — | — | system_computed | — | no | — |
| snapshot_reason | enum(`meal_consumed`,`daily_summary_finalized`,`coach_recommendation_issued`,`user_requested_export`,`manual_audit`,`daily_tracking`) | not null | — | — | system_computed | fixed set | no | `daily_tracking` added by Layer 10A — the one target context of a Profile-local day |
| linked_event_type | enum(`consumed_meal`,`daily_summary_finalized`,`coach_recommendation`,`other_auditable_decision`) | nullable | null | — | system_computed | — | no | null when not anchored to one row |
| linked_event_id | uuid | nullable | null | — | system_computed | required if `linked_event_type` set | no | — |
| created_at | timestamp | not null | now() | — | system_computed | forced to now() by trigger | no | exposed as `captured_at` for daily snapshots |
| local_date | date | nullable | null | unique with profile_id where reason = `daily_tracking` | client context (validated) | required for `daily_tracking`; must equal the current date in `local_timezone` at insert (trigger `effective_target_snapshot_current_local_date`) | no | Layer 10A — the Profile-local calendar day the target context applies to |
| local_timezone | text | nullable | null | — | client context (validated) | IANA identifier (API); recognised by PostgreSQL (trigger); paired with `local_date` | no | Layer 10A — frozen with the day's first capture |
| unresolved_fields | jsonb (array) | nullable | null | — | system_computed | required for `daily_tracking`; the resolver's `unresolved_fields` (`field_name`, `source`, `source_reference`, `reason`) | no | Layer 10A — distinguishes "field unresolved at capture" from "no target for the field" |
| created_by_account_id | uuid | nullable | — | FK → Account | system_computed | forced to `auth.uid()` by trigger | no | Layer 10A; not exposed by the API |

Row is write-once; no update path exists for any field after insert (Master §8, approved design). **Layer 10A daily semantics:** at most one `daily_tracking` snapshot per `(profile_id, local_date)` (partial unique index `uq_effective_target_snapshot_daily`); the first capture freezes the day's target and time zone; `daily_tracking` rows carry no linked event (`effective_target_snapshot_daily_context`). Only the current local date can be captured; no retroactive reconstruction.

---

## 12. MealLog

**Purpose:** a logical container for a profile's meals on a given day/occasion. Holds no independent status — status is owned solely by `MealItem` (§13) to avoid a dual source of truth; a MealLog's effective status is derived by reading its constituent MealItems.
**PII:** no. **Health:** yes. **Child-sensitive:** conditional.
**Retention:** Master §14.2. **Deletion:** with Profile. **Export:** included. **Audit:** none beyond standard.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| profile_id | uuid | not null | — | FK → Profile | system_computed | — | no | index |
| meal_type | enum(`breakfast`,`lunch`,`dinner`,`snack`,`other`) | not null | — | — | user_entered / system_computed | fixed set | yes | — |
| logged_date | date | not null | — | — | user_entered / system_computed | profile-local calendar date under `local_timezone`; every consumed item's `consumed_at` falls on it (Layer 7A) | yes (while items remain draft/planned); fixed once the meal holds a consumed item | — |
| local_timezone | text | not null for new rows (`meal_log_local_timezone_required`, NOT VALID) | — | — | user_entered | IANA identifier (e.g. `Asia/Dubai`, `UTC`); offsets and abbreviations rejected (`meal_log_integrity`) | no once the meal holds a consumed item | Layer 7A. The zone in which `logged_date` is a local day. No Profile default timezone yet |
| notes | text | nullable | null | — | user_entered | ≤ 2000 characters | set at creation | Layer 7A. Profile-scoped meal data; never nutrition input, not sent to AI |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

Index: `(profile_id, logged_date)`. Unique `(id, profile_id)` (target of MealItem's profile-consistency FK).

---

## 13. MealItem

**Purpose:** an individual food/recipe item within a MealLog — **actual consumption** (Layer 8A amendment, Master §6.6: planned intent lives in PlannedMealItem, §35; the `draft/planned/confirmed/skipped/cancelled` enum values remain but are unused by the official API).
**PII:** no. **Health:** yes. **Child-sensitive:** conditional.
**Retention:** Master §14.2. **Deletion:** with Profile; consumed rows are not individually user-deletable except via the correction/cancel paths. **Export:** included. **Audit:** consumed-state corrections logged to `AuditEvent` (§29_Data_Model.md §3.3).

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| meal_log_id | uuid | not null | — | FK → MealLog | system_computed | — | no | index |
| profile_id | uuid | not null | — | FK → Profile (denormalized) | system_computed | must match parent MealLog's profile_id | no | direct RLS filter |
| recipe_version_id | uuid | nullable | null | FK → RecipeVersion | user_entered | exactly one of `food_id`/`recipe_version_id` on a consumed item, never both (Layer 7A); must be a version of a Recipe authored by the same Profile (`meal_item_recipe_same_profile`) | at draft/planned only | the exact version consumed — never re-resolved to `Recipe.current_version_id` |
| recipe_personalized_variant_id | uuid | nullable | null | FK → RecipePersonalizedVariant | user_entered | — | at draft/planned only | — |
| food_id | uuid | nullable | null | FK → Food | user_entered / ai_derived | — | at draft/planned only | — |
| food_serving_id | uuid | nullable | null | FK → FoodServing; `(food_serving_id, food_id)` → FoodServing | user_entered / ai_derived | must belong to `food_id`; exclusive with `unit`; absent on a recipe item | at draft/planned only | — |
| unit | text | nullable | null | — | user_entered | exact Layer 5A registry code; Food items only; a consumed Food item has exactly one of `unit`/`food_serving_id` | at draft/planned only | Layer 7A |
| quantity | numeric | not null | — | — | user_entered / ai_derived | positive | at draft/planned only | Food item: amount in `unit` or number of `food_serving_id` servings. Recipe item: servings of the RecipeVersion's yield (fractional allowed). Transaction data — never a global FoodServing |
| status | enum(`draft`,`planned`,`confirmed`,`consumed`,`skipped`,`cancelled`) | not null | `draft` | — | system_computed | transitions per `29_Data_Model.md` §3.2 only | via defined transition actions only, never a free-form field edit | canonical Phase 1 lifecycle enum |
| confirmed_at | timestamp | nullable | null | — | system_computed | set only on `planned → confirmed` | no | — |
| consumed_at | timestamp | nullable | null | — | system_computed / user_entered | set on `confirmed → consumed`; for direct actual logging (Layer 7A) supplied by the client — when it was eaten, not when logged; not in the future; on the MealLog's `logged_date` in its `local_timezone` | no | distinct from `created_at` (when the record was written) |
| status_changed_by_actor_type | enum(`user`,`ai_optimizer`,`system`) | not null | `user` | — | system_computed | — | no | — |
| status_changed_by_account_id | uuid | nullable | null | FK → Account | system_computed | required if `status_changed_by_actor_type = user` | no | — |
| corrects_meal_item_id | uuid | nullable | null | self-FK → MealItem | system_computed | only settable when creating a correction row for a `consumed` item | no | — |
| superseded_by_meal_item_id | uuid | nullable | null | self-FK → MealItem | system_computed | set on the original when a correction is created | no | — |
| correction_reason | text | nullable | null | — | user_entered | required if `corrects_meal_item_id` set | at correction time only | — |
| nutrition_snapshot | jsonb | required when consumed | null | — | system_computed | `meal-item-snapshot-7a.1`: source, exact per-nutrient values + coverage, Layer 5B/6A provenance, rule versions | no — immutable once consumed; never client-supplied (API computes it) | Layer 7A. The nutrition recorded at logging time; history is read only from it. **Application-authoritative, not cryptographically attested** — see `33_Security_and_Privacy.md` §8.1 |
| nutrition_calculation_version | text | required when consumed | null | — | system_computed | e.g. `nutrition-calculation-5b.1` | no | Layer 7A |
| nutrition_calculated_at | timestamp | required when consumed | null | — | system_computed | — | no | Layer 7A |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | items logged together get strictly increasing `created_at` (logging order) |

Indexes: `(profile_id, meal_log_id)`, `(status)`, `(meal_log_id, status)`, unique `corrects_meal_item_id` (an item is superseded at most once). Composite FK `(meal_log_id, profile_id)` → MealLog enforces `profile_id` = the MealLog's.

Layer 7A consumed-row rules (`20261002120000`): a consumed item must have a source, an amount form valid for it, `consumed_at` and a complete snapshot; once consumed, the only permitted UPDATE sets `superseded_by_meal_item_id` once, to a correction of that item, with every other column unchanged; a correction row must target a consumed, unsuperseded item of the same MealLog and must supersede it in the same transaction; the supersession writes an AuditEvent (`meal_item_corrected`, ids only) via a SECURITY DEFINER trigger. No void/remove exists (deferred).

---

## 14. Food

**Purpose:** canonical, language-neutral food/product identity (reference data, not user data).
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** indefinite reference data — not subject to user deletion. **Deletion:** not user-deletable; removed only via data-source curation. **Export:** not included in user export (referenced by id). **Audit:** curation changes logged for data-integrity purposes.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| canonical_name | text | not null | — | — | trusted_database | language-neutral internal key, not a display name | no | unique |
| category | text | nullable | — | — | trusted_database | — | no | — |
| source | enum(`trusted_database`,`manufacturer_label`,`user_entered`,`ai_matched`) | not null | — | — | system_computed | fixed set (Master §16) | no | — |
| density_g_per_ml | numeric | nullable | null | — | trusted_database / manufacturer_label / ai_matched | positive; set together with `density_source` | no | Layer 5A. Only path for mass ↔ volume conversion; null = the food cannot be converted across dimensions (1 ml = 1 g is never assumed). An `ai_matched` density is never authoritative (`30_API.md` §14, rules 2, 8) |
| density_source | enum(`trusted_database`,`manufacturer_label`,`user_entered`,`ai_matched`) | nullable | null | — | system_computed | non-null iff `density_g_per_ml` is non-null (`food_density_source_pairing`); never `user_entered` (`food_density_no_personal_source`, Layer 5C) | no | Layer 5A. Provenance of the density value itself, independent of `source` |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 15. FoodAlias

**Purpose:** locale-aware display name/alias for a Food (Master §13.2).
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** reference data. **Deletion:** curated, not user-deletable. **Export:** n/a. **Audit:** curation changes logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| food_id | uuid | not null | — | FK → Food | system_computed | — | no | index |
| locale | text | not null | — | — | trusted_database | BCP 47 | no | — |
| alias_text | text | not null | — | — | trusted_database / ai_matched | — | no | AI-matched aliases require validation before becoming authoritative (Master §16). An `ai_matched` alias is a food-**identity** hint only; it never makes nutrient, serving-weight or density data authoritative (`30_API.md` §14, rule 8) |
| is_primary | boolean | not null | false | — | trusted_database | at most one primary per `(food_id, locale)` | no | — |
| source | enum(`trusted_database`,`user_entered`,`ai_matched`) | not null | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique: `(food_id, locale, alias_text)`. Index: `(locale, alias_text)` for search.

---

## 16. FoodServing

**Purpose:** locale/region-aware serving description with a canonical deterministic quantity (Master §13.3).
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** reference data. **Deletion:** curated. **Export:** n/a. **Audit:** curation changes logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| food_id | uuid | not null | — | FK → Food | system_computed | — | no | index |
| serving_description | text | not null | — | — | trusted_database | — | no | locale-specific text; localization is **deferred** — no `locale` column yet, returned as stored (`30_API.md` §14, rule 10) |
| region | text | nullable | null | — | trusted_database | BCP 47 region/market subtag | no | null = region-agnostic |
| canonical_quantity | numeric | not null | — | — | trusted_database | positive | no | — |
| canonical_unit | text | not null | — | — | trusted_database | `g` or `ml` only (`food_serving_canonical_unit_base`, Layer 5A) | no | the two canonical base units of the conversion engine |
| source | enum(`trusted_database`,`user_entered`,`ai_matched`) | not null | — | — | system_computed | `user_entered` rejected (`food_serving_no_personal_source`, Layer 5C) | no | a user-entered serving is personal data and has no place in this global table |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique: `(food_id, serving_description, region)`.

---

## 17. Nutrient

**Purpose:** canonical, language-neutral nutrient identity (Master §13.4). Localized display labels live in a separate `(nutrient_id, locale)` lookup, deferred to `06_Nutrition_Database.md` — not separately dictionaried here. The canonical vocabulary (22 keys, roles, reporting units, meanings) is fixed in `30_API.md` §16 (Layer 5C).
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** indefinite reference data. **Deletion:** not user-deletable. **Export:** n/a. **Audit:** curation changes logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| canonical_key | text | not null | — | — | trusted_database | e.g. `protein`, `fiber`, `vitamin_c` | no | unique |
| role | enum(`energy`,`macronutrient`,`fiber`,`micronutrient`,`other`) | not null | `other` | — | trusted_database | role ↔ unit rule `nutrient_role_reporting_unit`; one `energy` row only | no | Layer 5C; explicit metadata, never inferred from labels |
| unit | text | not null | — | — | trusted_database | energy→kcal; macronutrient/fiber→g; micronutrient→mg/mcg (Layer 5C) | no | the canonical **reporting** unit; every FoodNutrient amount for this nutrient is expressed in it. Layer 5B converts only within g/mg/mcg and never kcal ↔ kJ (`30_API.md` §15) |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 18. FoodNutrient

**Purpose:** a sourced nutrient amount for a Food, per canonical reference quantity (Master §16 — multiple sourced values coexist rather than overwriting).
**Scope:** **global/reference nutrition data** — no owner column, readable by every authenticated account, written only by trusted ingestion/admin workflows. Personal user-entered nutrition values are **not** stored here (they belong to a future profile/product-scoped storage model), and AI estimates are **not** stored here as global nutrition truth (Layer 5C final boundary, `food_nutrient_global_source`).
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** reference data. **Deletion:** curated. **Export:** n/a. **Audit:** curation changes logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| food_id | uuid | not null | — | FK → Food | system_computed | — | no | index |
| nutrient_id | uuid | not null | — | FK → Nutrient | system_computed | — | no | index |
| amount_per_canonical_unit | numeric | not null | — | — | trusted_database / manufacturer_label | non-negative | no | amount of the nutrient (in `Nutrient.unit`) per `basis_quantity` `basis_unit` of the food; column name kept from Layer 1. Calculations must read the explicit basis — never assume per 100 g (`30_API.md` §14, rule 1) |
| basis_quantity | numeric | not null | 100 | — | trusted_database / manufacturer_label | positive | no | Layer 5A. Makes the reference basis explicit (previously only documented as "e.g. per 100g") |
| basis_unit | text | not null | `g` | — | trusted_database / manufacturer_label | `g` or `ml` | no | Layer 5A |
| source | enum(`trusted_database`,`manufacturer_label`,`user_entered`,`ai_matched`) | not null | — | — | system_computed | new/updated rows: `trusted_database` or `manufacturer_label` only (`food_nutrient_global_source`, migration `20260930120000`) | no | the enum is shared with Food and keeps all four values; `user_entered`/`ai_matched` are rejected for this table. `manufacturer_label` is representable, but exact-product resolution waits for Product/Barcode. The constraint is `NOT VALID`: any pre-existing `user_entered`/`ai_matched` row is retained (not deleted) for review and still excluded by the engine; `VALIDATE CONSTRAINT` once reviewed |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique: `(food_id, nutrient_id, source)` — multiple sourced values per pair are intentional, not a conflict. The reference-data layer never chooses a source; the Layer 5B engine does, per its source-resolution policy (`30_API.md` §15): only `trusted_database`/`manufacturer_label` are authoritative, both present ⇒ `ambiguous_nutrient_source`, never summed or averaged. A stored amount of 0 is a **known zero**; the absence of a row is **unknown** — ingestion must not insert 0 for a nutrient the source does not report.

---

## 19. Recipe

**Purpose:** the base, normalized recipe identity (Master §11.1).
**PII:** no (content); `created_by_*` fields are attribution/PII-adjacent. **Health:** no. **Child-sensitive:** no.
**Retention:** persistent library content. **Deletion:** user-deletable individually, or with account/profile deletion (subject to shared-library implications owned by `10_Recipe_Library.md`). **Export:** included. **Audit:** creation logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| canonical_title | text | not null | — | — | user_entered / ai_derived | — | indirectly (via new RecipeVersion) | — |
| created_by_account_id | uuid | nullable | null | FK → Account | system_computed | — | no | null for platform-seeded recipes |
| created_by_profile_id | uuid | nullable | null | FK → Profile | system_computed | — | no | — |
| visibility | enum(`private`,`shared_library`) | not null | `private` | — | user_entered | exact discovery rules owned by `10_Recipe_Library.md` | yes | — |
| current_version_id | uuid | nullable | null | FK → RecipeVersion | system_computed | must point to a version of this Recipe — enforced by `trg_recipe_current_version_belongs` (Layer 6A) | no | convenience pointer to latest accepted version; moved atomically with each new version by `create_recipe_version()` (Layer 6A) |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 20. RecipeVersion

**Purpose:** revision history of the base Recipe's canonical representation (Master §11.2); append-only, never edited in place.
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** persistent, with Recipe. **Deletion:** with Recipe. **Export:** included. **Audit:** creation logged, especially when import-derived.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| recipe_id | uuid | not null | — | FK → Recipe | system_computed | — | no | index |
| version_number | integer | not null | — | — | system_computed | monotonically increasing per recipe | no | — |
| title | text | not null | — | — | user_entered / ai_derived | — | no (immutable) | — |
| description | text | nullable | null | — | user_entered / ai_derived | — | no | — |
| servings | numeric | nullable | null | — | user_entered / ai_derived | positive | no | — |
| origin_url_source_id | uuid | nullable | null | FK → UrlSource | system_computed | — | no | null for manually authored versions |
| origin_import_job_id | uuid | nullable | null | FK → ImportJob | system_computed | — | no | §29_Data_Model.md §7.4 traceability |
| origin_ai_extraction_id | uuid | nullable | null | FK → AiExtraction | system_computed | — | no | — |
| created_by_account_id | uuid | nullable | null | FK → Account | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique: `(recipe_id, version_number)`.

---

## 21. RecipeIngredient

**Purpose:** one ingredient line within a RecipeVersion.
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention/Deletion/Export:** inherits RecipeVersion. **Audit:** none beyond version creation.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| recipe_version_id | uuid | not null | — | FK → RecipeVersion | system_computed | — | no | index |
| food_id | uuid | nullable | null | FK → Food | ai_derived | — | no | null if unmatched/ambiguous |
| raw_ingredient_text | text | not null | — | — | user_entered / ai_derived | original text as authored/imported | no (immutable) | provenance trail |
| quantity | numeric | nullable | null | — | user_entered / ai_derived | positive | no | — |
| unit | text | nullable | null | — | user_entered / ai_derived | Layer 6A API: an exact Layer 5A registry unit code; exclusive with `food_serving_id`; requires `quantity` | no | — |
| food_serving_id | uuid | nullable | null | FK → FoodServing `(food_serving_id, food_id)` | user_entered | must belong to this row's `food_id`; requires `food_id` and `quantity`; exclusive with `unit` | no | Layer 6A (`20261001120000`). Amount = `quantity` × this serving. Recipe-specific input: never creates or changes a global FoodServing |
| match_confidence | numeric | nullable | null | — | ai_derived | present only when `food_id` was AI-matched | no | — |
| match_status | enum(`matched`,`needs_confirmation`,`unmatched`) | not null | `needs_confirmation` | — | system_computed | — | no | Master §16/§18 |
| sort_order | integer | not null | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Layer 6A semantics: an ingredient counts toward recipe nutrition only when `match_status = matched`, `food_id` is set and it has `quantity` plus `unit` or `food_serving_id`. Anything else (unmatched text, `needs_confirmation`, no quantity, a count without unit) is kept verbatim and reported as unresolved, making the affected totals partial/unavailable — it is never force-matched or treated as 0 (`30_API.md` §17). A manually selected Food is stored as `matched` with `match_confidence` null. No calculated nutrient value is stored on this row.

---

## 22. RecipeInstruction

**Purpose:** one instruction step within a RecipeVersion.
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention/Deletion/Export/Audit:** inherits RecipeVersion.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| recipe_version_id | uuid | not null | — | FK → RecipeVersion | system_computed | — | no | index |
| step_number | integer | not null | — | — | system_computed | — | no | — |
| instruction_text | text | not null | — | — | user_entered / ai_derived | — | no (immutable) | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique: `(recipe_version_id, step_number)`.

---

## 23. RecipePersonalizedVariant

**Purpose:** profile-specific derivative of a base recipe/version (Master §11.3); never a destructive edit of the base.
**PII:** no. **Health:** yes (dietary adjustment). **Child-sensitive:** conditional.
**Retention:** profile-active. **Deletion:** with Profile. **Export:** included. **Audit:** creation logged when `ai_generated = true` and material.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| base_recipe_id | uuid | not null | — | FK → Recipe | system_computed | — | no | index |
| base_recipe_version_id | uuid | not null | — | FK → RecipeVersion | system_computed | — | no | — |
| profile_id | uuid | not null | — | FK → Profile | system_computed | — | no | index |
| adjustments_payload | jsonb | not null | — | — | user_entered / ai_derived | structured substitutions/portion/ingredient changes | yes | never overwrites `RawContent` or base Recipe/RecipeVersion |
| ai_generated | boolean | not null | false | — | system_computed | — | no | — |
| source_confidence | numeric | nullable | null | — | ai_derived | present only if `ai_generated = true` | no | — |
| user_accepted_at | timestamp | nullable | null | — | user_entered | required before a material AI-generated variant is treated as approved (Master §5, §11.3) | yes (accept action) | — |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 24. UrlSource

**Purpose:** persistent external source/resource identity (finalized architecture, `29_Data_Model.md` §7.1–7.2).
**PII:** no (resource identity; attribution lives on `ImportJob`). **Health:** no. **Child-sensitive:** no.
**Retention:** Master §14.4 — operational/provenance, not archival. **Deletion:** purged per retention window, or earlier with linked account/profile deletion. **Export:** not included in standard export. **Audit:** none beyond creation.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| canonical_url | text | not null | — | — | system_computed | normalized form | no | unique |
| original_url | text | not null | — | — | user_entered | as submitted | no | — |
| source_provider | enum(`instagram`,`tiktok`,`youtube`,`web`,`manual`) | not null | — | — | system_computed | fixed set | no | — |
| first_seen_at | timestamp | not null | now() | — | system_computed | — | no | — |
| last_checked_at | timestamp | not null | now() | — | system_computed | updated by any ImportJob attempt | no | — |
| latest_content_fingerprint | text | nullable | null | — | system_computed | denormalized from latest successful ImportJob | no | authoritative value lives on ImportJob/RawContent |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 25. ImportJob

**Purpose:** one ingestion/processing operation performed against a UrlSource (finalized architecture, `29_Data_Model.md` §7.1, §7.3). `UrlSource 1 → N ImportJob`.
**PII:** attribution fields are PII-adjacent. **Health:** no. **Child-sensitive:** no.
**Retention:** Master §14.4. **Deletion:** purged per retention window, or with linked Account deletion. **Export:** not included in standard export. **Audit:** processing-status transitions logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| url_source_id | uuid | not null | — | FK → UrlSource | system_computed | — | no | index |
| idempotency_key | text | not null | — | — | user_entered / system_computed | — | no | unique |
| trigger_type | enum(`initial_import`,`retry`,`manual_reimport`,`scheduled_recheck`) | not null | — | — | system_computed | fixed set | no | — |
| requested_by_account_id | uuid | nullable | null | FK → Account | system_computed | null only for `scheduled_recheck` | no | — |
| requested_by_profile_id | uuid | nullable | null | FK → Profile | system_computed | same rule | no | — |
| content_fingerprint | text | nullable | null | — | system_computed | set once fetch completes | no | this attempt's fingerprint, distinct from `UrlSource.latest_content_fingerprint` |
| extraction_model_version | text | nullable | null | — | ai_derived | set once extraction runs | no | — |
| processing_status | enum(`queued`,`processing`,`needs_confirmation`,`succeeded`,`retryable_failed`,`permanently_failed`,`cancelled`) | not null | `queued` | — | system_computed | canonical Phase 1 enum | no | — |
| retry_count | integer | not null | 0 | — | system_computed | — | no | — |
| error_code | text | nullable | null | — | system_computed | — | no | — |
| started_at | timestamp | nullable | null | — | system_computed | — | no | — |
| completed_at | timestamp | nullable | null | — | system_computed | — | no | — |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

Index: `(url_source_id, created_at)`.

---

## 26. RawContent

**Purpose:** the raw fetched artifact for one specific ImportJob attempt (Master §5/§12 raw/normalized separation).
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** Master §14.4 — bounded operational window, not archival. **Deletion:** purged per window or with linked Account. **Export:** not included. **Audit:** none beyond creation/purge logging.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| import_job_id | uuid | not null | — | FK → ImportJob | system_computed | — | no | index; required per attempt |
| url_source_id | uuid | not null | — | FK → UrlSource (denormalized) | system_computed | must match parent ImportJob's url_source_id | no | — |
| content_type | enum(`html`,`json`,`image`,`video`,`transcript`) | not null | — | — | system_computed | — | no | — |
| storage_reference | text | not null | — | — | system_computed | pointer into object storage, never inline blob | no | — |
| fetched_at | timestamp | not null | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | immutable — a new ImportJob produces a new row, never an in-place overwrite |

---

## 27. AiExtraction

**Purpose:** one AI extraction result derived from a RawContent (Master §5, §12, §18).
**PII:** no. **Health:** no (payload may reference food/recipe content, not personal health data). **Child-sensitive:** no.
**Retention:** tied to parent RawContent's window. **Deletion:** purged with RawContent. **Export:** not included. **Audit:** creation logged; downstream promotion into Recipe/Food data carries this record's id forward as provenance.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| raw_content_id | uuid | not null | — | FK → RawContent | system_computed | — | no | index |
| import_job_id | uuid | not null | — | FK → ImportJob (denormalized) | system_computed | must match parent chain | no | §29_Data_Model.md §7.4 |
| source | enum(`photo`,`voice_transcript`,`url_import`,`barcode_lookup_ambiguity`) | not null | — | — | system_computed | fixed set | no | — |
| extraction_method | text | not null | — | — | system_computed | model/prompt/pipeline identifier | no | — |
| model_version | text | not null | — | — | system_computed | — | no | — |
| confidence | numeric | not null | — | — | ai_derived | 0–1 or defined band | no | — |
| status | enum(`success`,`partial_success`,`needs_confirmation`,`retryable_failure`,`permanent_failure`) | not null | — | — | system_computed | canonical Phase 1 enum, aligned with `ImportJob.processing_status`'s `needs_confirmation` naming | no | Master §18 |
| extracted_payload | jsonb | not null | — | — | ai_derived | structured output prior to validation/acceptance | no | not authoritative until validated (Master §16) |
| created_at | timestamp | not null | now() | — | system_computed | — | no | immutable; a re-run produces a new row |

---

## 28. WearableConnection

**Purpose:** a Profile's connection to a wearable/health-platform provider (Master §17).
**PII:** no. **Health:** yes. **Child-sensitive:** conditional.
**Retention:** while connection active + profile-active. **Deletion:** with Profile, or on disconnect per provider terms. **Export:** included. **Audit:** connect/disconnect logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| profile_id | uuid | not null | — | FK → Profile | system_computed | — | no | index |
| provider | enum(`whoop`,`apple_healthkit`,`android_health_connect`) | not null | — | — | user_entered | fixed set | no (connect action only) | — |
| provider_account_reference | text | not null | — | — | synced_external | opaque external identifier | no | — |
| connected_at | timestamp | not null | — | — | system_computed | — | no | — |
| disconnected_at | timestamp | nullable | null | — | user_entered | — | yes (disconnect action) | — |
| sync_cursor | text | nullable | null | — | synced_external | opaque provider checkpoint | no | — |
| last_sync_status | enum(`success`,`partial`,`retryable_failure`,`permanent_failure`) | nullable | null | — | system_computed | — | no | — |
| retry_count | integer | not null | 0 | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique: `(profile_id, provider)` — one active connection per provider per profile in Phase 1 (multi-device-per-provider deferred).

---

## 29–32. Activity, Workout, Sleep, Recovery

**Purpose:** synced wearable measurement records, one entity per domain, sharing a common provenance/idempotency shape (Master §17).
**PII:** no. **Health:** yes. **Child-sensitive:** conditional.
**Retention:** profile-active. **Deletion:** with Profile or on disconnect. **Export:** included. **Audit:** none beyond standard sync logging (high volume, not individually audited); `user_override` writes are logged.

Common fields (all four entities):

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| wearable_connection_id | uuid | not null | — | FK → WearableConnection | system_computed | — | no | index |
| profile_id | uuid | not null | — | FK → Profile (denormalized) | system_computed | — | no | index |
| provider_record_id | text | not null | — | — | synced_external | idempotent upsert key | no | — |
| recorded_at | timestamp with time zone | not null | — | — | synced_external | — | no | — |
| provenance | enum(`wearable_direct`,`wearable_derived`,`user_override`) | not null | — | — | system_computed | fixed set | — | `user_override` is the only user-editable path |
| synced_at | timestamp | not null | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique (all four): `(wearable_connection_id, provider_record_id)` — idempotent upsert key per Master §17.

Domain-specific fields:
- **Activity:** `activity_type` (text, not null, synced_external), `duration_minutes` (numeric, not null), `energy_kcal` (numeric, nullable).
- **Workout:** `workout_type` (text, not null), `duration_minutes` (numeric, not null), `energy_kcal` (numeric, nullable), `avg_heart_rate` (numeric, nullable).
- **Sleep:** `sleep_start_at` (timestamp, not null), `sleep_end_at` (timestamp, not null), `sleep_stage_breakdown` (jsonb, nullable).
- **Recovery:** `recovery_score` (numeric, nullable), `hrv_ms` (numeric, nullable), `resting_heart_rate` (numeric, nullable).

All domain-specific fields: not user-editable except via an explicit `user_override` record (never an in-place edit of a `wearable_direct`/`wearable_derived` row).

---

## 33. AuditEvent

**Purpose:** append-only security/audit log entry.
**PII:** references actor/subject, not itself broad PII content. **Health:** no — payload must exclude health/child content (Master §31). **Child-sensitive:** no (by construction — see validation).
**Retention:** Master §14.5 — retention period set explicitly before production release. **Deletion:** not user-deletable (audit integrity); purged only per documented log-retention schedule. **Export:** not included in standard user export. **Audit:** self (this is the audit record).

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| actor_account_id | uuid | nullable | null | FK → Account | system_computed | null for system-initiated events | no | — |
| actor_type | enum(`user`,`system`,`ai_optimizer`,`worker`) | not null | — | — | system_computed | fixed set | no | — |
| event_type | text | not null | — | — | system_computed | e.g. `meal_item_corrected`, `guardian_authorization_revoked`, `clinician_target_entered`, `device_session_revoked` | no | — |
| subject_type | text | not null | — | — | system_computed | entity name the event concerns | no | — |
| subject_id | uuid | not null | — | — | system_computed | — | no | — |
| event_payload | jsonb | nullable | null | — | system_computed | must exclude full health/child content, tokens, secrets (Master §31) | no | safe summary only |
| occurred_at | timestamp | not null | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 34. Entities Deferred to Their Owning Phase

Carried forward in `29_Data_Model.md` §2's entity inventory but not dictionaried at field level here, because their full shape belongs to a later phase's own module spec and nothing in Phase 1 (auth, profile, session, targets, meal lifecycle, recipe versioning/personalization, import, AI provenance, wearable provenance, audit) depends on their field-level detail yet: `RecipeCategory`, `RecipeTag`, `RecipeRating` (→ `10_Recipe_Library.md`), (`Product`, `Barcode`: dictionaried in §39, Layer 11A), `CycleRecord`, `PregnancyProfile`, `PostpartumProfile`, `BreastfeedingProfile` (→ `18_Womens_Nutrition_Intelligence.md`), `CoachRecommendation` (→ `13_Adaptive_Nutrition_Coach.md`), `NotificationPreference` (→ `28_Notifications.md`). Each must receive its own field-level dictionary pass, in the same format as this document, before its owning phase's migrations are written.

---

## 35. Meal Planning entities (Phase 2 Layer 8A)

Planned **intent**, separate from actual consumption (Master §6.6). `26_Meal_Planning.md` is not available; these definitions are the approved Layer 8A decisions. **PII:** no. **Health:** yes. **Child-sensitive:** conditional. **Retention:** profile-active. **Deletion:** with Profile (no client DELETE). **Export:** included. **Audit:** none beyond standard. Access: `33_Security_and_Privacy.md` §8.0/§9.1.

**MealPlan** — `id` uuid PK · `profile_id` uuid FK → Profile (immutable) · `name` text 1–200 · `description` text ≤ 2000, nullable · `start_date` / `end_date` date, `start_date ≤ end_date`, ≤ 366 days (API) · `local_timezone` text, IANA identifier (validated), fixed once not draft · `status` enum(`draft`,`active`,`completed`,`cancelled`,`archived`), default `draft`; transitions draft→active (via confirmation) | cancelled, active→completed | cancelled, completed | cancelled→archived; no automatic completion · `created_by_account_id` nullable FK → Account (not exposed) · `created_at`/`updated_at`. Date range: draft — change allowed unless a planned day would fall outside; active — extension only; completed/cancelled/archived — immutable. Unique `(id, profile_id)`.

**MealPlanDay** — `id` · `meal_plan_id` + `profile_id` (composite FK → MealPlan) · `plan_date` date, inside the plan range (trigger) · `created_at`. Unique `(meal_plan_id, plan_date)`. Insert-only.

**PlannedMeal** — `id` · `meal_plan_day_id` + `profile_id` (composite FK → MealPlanDay) · `meal_type` (shared `meal_type` enum) · `scheduled_local_time` time, nullable, wall clock in the plan's zone · `notes` ≤ 2000 · `position` int ≥ 0 · `created_by_account_id` · `created_at`. Insert-only.

**PlannedMealItem** — `id` (stable; Layer 8B links planned → actual by it) · `planned_meal_id` + `profile_id` (composite FK → PlannedMeal) · source, exactly one of: Food (`food_id`; `quantity` + `unit` (Layer 5A code) **or** `quantity` × `food_serving_id`, the serving belonging to that Food — composite FK) or Recipe (`recipe_id` + `recipe_version_id`, composite FK → RecipeVersion `(id, recipe_id)`, recipe authored by the same Profile — trigger; `quantity` = servings, no unit/serving) · `quantity` numeric > 0 · `position` · `status` enum(`draft`,`planned`,`confirmed`,`cancelled`) — created as draft/planned; draft→planned|confirmed|cancelled, planned→confirmed|cancelled; never consumed · `confirmed_at`, `nutrition_snapshot` jsonb (`planned-item-snapshot-8a.1`, same shape as the MealItem snapshot), `nutrition_calculation_version`, `nutrition_calculated_at` — all present exactly when confirmed, server-computed, application-authoritative · `supersedes_planned_meal_item_id` (a replacement of a confirmed, current item of the same planned meal; at most one live replacement) · `superseded_by_planned_meal_item_id` (set once, by confirmation of the replacement; only on confirmed rows) · `created_by_account_id` · `created_at`/`updated_at`. Confirmed rows are immutable except that one supersession write; draft/planned rows may change amount/position/status but not identity or source. Grocery derivation reads `food_id`/`food_serving_id`/`quantity`/`unit` or `recipe_id`/`recipe_version_id`/servings (and the version's RecipeIngredients) — never nutrition totals.

## 36. Planned vs actual entities (Phase 2 Layer 8B)

Explicit relationships between planned intent (§35) and actual consumption (MealItem). Fulfillment is **derived at read time** and never stored. **PII:** no. **Health:** yes. **Child-sensitive:** conditional. **Retention:** profile-active. **Deletion:** with Profile (no client DELETE; revocation only). **Export:** included. **Audit:** creator/revoker Account ids and timestamps on the row (not exposed by the API). Access: `33_Security_and_Privacy.md` §8.0/§9.1. Migration: `20261005120000_planned_actual_links.sql`.

**PlannedActualLink** — `id` uuid PK · `profile_id` uuid · `planned_meal_item_id` (composite FK `(planned_meal_item_id, profile_id)` → PlannedMealItem) · `meal_item_id` (composite FK → MealItem; the record linked at creation — never rewritten) · `relationship_type` enum `planned_actual_relationship` (`same_item` — the same Food or exact RecipeVersion; `substitution` — a different Food or RecipeVersion) · `meal_item_chain_root_id` (composite FK → MealItem; set by trigger: the original record of the linked item's 7A correction chain) · `created_at` (server time) · `created_by_account_id` (= `auth.uid()`, forced) · `revoked_at` / `revoked_by_account_id` (both null = active; set together, once, forced to server time and `auth.uid()`). Insert rules (trigger, errcode 23514/23505 with the named constraint): caller holds a write scope on the Profile; planned item confirmed, not superseded, on an `active`/`completed` plan (`planned_item_current_confirmed`, `planned_item_plan_status`); MealItem of the same Profile, consumed and not superseded (`planned_actual_link_actual_active`); `consumed_at` in the plan's time zone = the plan day's date (`planned_actual_link_same_plan_day`); identity matches the relationship (`planned_actual_link_same_identity`, `planned_actual_link_substitution_identity`); no active skip (`planned_actual_link_not_skipped`); the chain is not already actively linked to this planned item (`uq_planned_actual_link_active`) or to another **current** planned item (`planned_actual_link_one_current_plan_item`). Revocation (only on `active`/`completed` plans) is the only permitted update; revoked rows are immutable. Partial unique index on active `(planned_meal_item_id, meal_item_id)`.

**PlannedMealItemSkip** — `id` uuid PK · `profile_id` · `planned_meal_item_id` (composite FK → PlannedMealItem) · `reason` text ≤ 500, nullable · `skipped_at` (server time) · `skipped_by_account_id` (= `auth.uid()`) · `revoked_at` / `revoked_by_account_id` (unskip). Insert rules: write scope; planned item confirmed, current, on an `active`/`completed` plan; no active link (`planned_meal_item_skip_no_links`); at most one active skip per planned item (`uq_planned_meal_item_skip_active`). Skipping does not modify the PlannedMealItem. Cancelled (8A) ≠ skipped.

**Derived (not stored)** — per current confirmed planned item: `fulfillment_state` ∈ `unlinked | partial | fulfilled_exact | above_planned_quantity | fulfilled_with_substitution | skipped | quantity_not_comparable | identity_changed_by_correction`; per link `link_state` ∈ `valid | identity_changed_by_correction | consumed_date_changed_by_correction | actual_not_active` and `counted`; quantity comparison (servings for recipes; declared amount — quantity in its unit, or servings × the serving's canonical amount — else the recorded normalized g/ml quantity; otherwise not comparable); nutrition comparison from the stored snapshots (difference = actual − planned only where both sides are complete); unplanned actual items. Rules version `plan-fulfillment-8b.1`.

## 37. Grocery Planning entities (Phase 2 Layer 9A)

Generated grocery requirements derived from a MealPlan's planned intent (`00_Master.md` §6.7; Data Model §3.7). **PII:** no. **Health:** indirectly (derived from a plan). **Child-sensitive:** conditional. **Retention:** profile-active. **Deletion:** with Profile (no client DELETE). **Export:** included. **Audit:** generator Account id and time on GroceryList (not exposed by the API). Access: `33_Security_and_Privacy.md` §8.0/§9.1. Migration: `20261006120000_grocery_planning_core.sql`.

**GroceryList** — `id` uuid PK · `profile_id` FK → Profile · `meal_plan_id` (composite FK `(meal_plan_id, profile_id)` → MealPlan) · `generation_number` int ≥ 1, unique per plan, assigned by trigger (max + 1, serialized per plan) · `status` enum `grocery_list_status` (`active`, `superseded`); one `active` per plan (partial unique index) · `supersedes_grocery_list_id` / `superseded_by_grocery_list_id` (composite self-FKs; the latter deferred to commit) · `superseded_at` · `plan_status_at_generation`, `plan_start_date`, `plan_end_date`, `plan_local_timezone` (copied from the plan by trigger) · `source_fingerprint` (64 hex, SHA-256) · `fingerprint_version` (`grocery-source-fingerprint-9a.1`) · `calculation_version` (`grocery-calculation-9a.1`) · `conversion_version` (`conversion-5a.1`) · `excluded_sources` jsonb array (current plan items not included: `{planned_meal_item_id, planned_meal_id, meal_plan_day_id, plan_date, meal_type, status, reason: unconfirmed | pending_replacement_not_confirmed | skipped, source_type, food_id, recipe_version_id}`) · `generated_at` (server; the generating transaction's time) · `generated_by_account_id` (= `auth.uid()`). Insert rules (trigger): caller holds a write scope; the plan belongs to the Profile (`P0002` otherwise) and is `active` (`grocery_list_plan_active`); the previous active generation is superseded in the same transaction. The only permitted update is that supersession (`grocery_list_immutable`); `authenticated` has no UPDATE/DELETE grant.

**GroceryListItem** — `id` · `grocery_list_id` + `profile_id` (composite FK → GroceryList) · `position` (unique per list) · `food_id` FK → Food, null exactly for `unresolved_food` · `display_name` (Food canonical name, or the ingredient text) · `dimension` enum (`mass`, `volume`, `count`) with `unit` `g` / `ml` / `count` · `quantity_exact` ("n/d") and `quantity` (rounded half-up to 6 dp) — present exactly for `resolved` / `incompatible_units` · `resolution_status` enum `grocery_resolution_status` (`resolved`; `incompatible_units` — one Food with components that cannot be reconciled, each kept with a reason such as `mass_volume_density_unavailable`, `mass_volume_density_not_trusted_reference`, `count_not_convertible_to_mass_or_volume`; `unresolved_quantity` — `no_quantity`; `ambiguous_unit` — `ambiguous_unit:<candidates>`; `unresolved_conversion` — e.g. `serving_not_found`, `serving_not_trusted_reference`, `unknown_unit`; `unresolved_food` — `ingredient_needs_confirmation`, `ingredient_unmatched`, `food_reference_missing`) · `aggregation_status` (`aggregated` / `not_aggregated`) · `unresolved_reason` (null exactly when resolved) · `source_count`. Written only inside the generating transaction (`grocery_list_sealed`); never updated. No shopping state (already-have, purchased, checked, manual, retailer product, price, user-edited quantity).

**GroceryListItemSource** — `id` · `grocery_list_item_id` + `profile_id` (composite FK) · `grocery_list_id` (composite FK) · `position` · `meal_plan_id`, `meal_plan_day_id`, `planned_meal_id`, `planned_meal_item_id` (each a composite FK with `profile_id`) · `plan_date` · `source_type` (`planned_food`, `recipe_ingredient`) · `food_id`, `food_serving_id` · `recipe_id` + `recipe_version_id` (composite FK → RecipeVersion `(id, recipe_id)`) · `recipe_ingredient_id` FK · `ingredient_text`, `ingredient_match_status` · `source_quantity`, `source_unit` (as stored on the planned item / ingredient) · `planned_servings`, `recipe_yield` · `scale_factor_exact` (servings ÷ yield; 1 for a planned Food) · `scaled_quantity_exact` · `contribution_quantity_exact` + `contribution_unit` (the amount added to the item, after any density step) · `conversion` jsonb (Layer 5A steps and provenance) · `unresolved_reason`. Insert rules (trigger): written inside the generating transaction; the item belongs to the list; the planned item belongs to the list's plan at that day/meal (`grocery_source_in_plan`) and is confirmed, current and not skipped (`grocery_source_confirmed_current`); its Food/serving/unit/quantity, or exact RecipeVersion/servings and the RecipeIngredient's version, Food, match status, serving, quantity, unit and the version's yield, equal the row (`grocery_source_matches_plan`). Never updated.

**Derived (not stored)** — `is_stale` = the current source fingerprint (current, confirmed, non-skipped plan items + their RecipeVersions' ingredient facts, canonical JSON, SHA-256) differs from `source_fingerprint`. Reference-data changes (servings, density) do not make a list stale and never rewrite it.

## 38. Grocery workflow — user shopping state (Phase 2 Layer 9B)

User facts about shopping, kept separate from the generated requirement (§37). **PII:** no. **Health:** no (shopping facts). **Child-sensitive:** conditional (a child Profile's list). **Retention:** profile-active. **Deletion:** with Profile (no client DELETE; revocation only). **Export:** included. **Audit:** creator/revoker Account ids and times on each row (not exposed by the API). Access: `33_Security_and_Privacy.md` §8.0/§9.1. Migration: `20261007120000_grocery_shopping_state.sql`.

Common to all four: `id` uuid PK · `profile_id` · `grocery_list_id` (composite FK `(grocery_list_id, profile_id)` → GroceryList) · `created_at` (server) · `created_by_account_id` (= `auth.uid()`, forced) · `revoked_at` / `revoked_by_account_id` (both null = active; set together, once, forced to server time and `auth.uid()`). Insert and revocation (triggers): caller holds a write scope; the list belongs to the Profile (`P0002`) and is the **active** generation of an `active` or `completed` plan (`grocery_shopping_list_writable`); revocation is the only permitted update and a revoked row is immutable. Quantities are stored as entered; `unit` is an exact Layer 5A unit code or `count` (API-validated; ambiguous household units are not accepted).

**GroceryItemAlreadyHave** — `grocery_list_item_id` (composite FK `(grocery_list_item_id, grocery_list_id)` → GroceryListItem) · `quantity` numeric ≥ 0 · `unit` · `note` ≤ 500. At most one active per item (partial unique index); a new value revokes the previous one in the same statement.

**GroceryItemShoppingAdjustment** — same shape: the quantity the user intends to buy for the item (overrides the generated-derived target while active; ≥ 0, 0 = buy none). At most one active per item; clearing revokes.

**GroceryPurchase** — exactly one of `grocery_list_item_id` (composite FK → GroceryListItem of the same list) or `grocery_manual_item_id` (composite FK → GroceryManualItem of the same list) · `quantity` numeric > 0 + `unit`, or both null (a check-off) · `note`. Many active per target; not insertable for a removed manual item (`grocery_purchase_manual_item_active`).

**GroceryManualItem** — `name` 1–200 · `quantity` > 0 + `unit`, or both null · `food_id` FK → Food, optional (intentional selection; the item stays manual — no GroceryListItemSource, no plan provenance) · `notes` ≤ 1000. Removal = revocation. Never used for nutrition.

**Derived (not stored; rules `grocery-shopping-9b.1`)** — per generated item: `derived_need`, `already_have_surplus`, `shopping_target` + `shopping_target_source` (`generated` | `user_adjusted`), `purchased`, `remaining_to_purchase`, `over_purchased`, `status` (`need_to_buy`, `partially_purchased`, `purchased`, `already_have_sufficient`, `no_purchase_needed`, `comparison_unresolved`), `purchase_mode` (`quantity` | `check_off`). User quantities are normalized with Layer 5A into the item's base (`g`, `ml`, `count`); mass ↔ volume only through the Food's trusted density; count never converts; anything incomparable is listed and not counted.

---

## 39. Product & Barcode entities (Phase 3 Layer 11A)

Global reference data (Master §16.1; Data Model §4.7). **PII:** no. **Health:** no. **Child-sensitive:** no. **Retention:** reference data (history never deleted — DELETE is blocked for every role). **Export:** not user data. **Audit:** provenance columns on each row. Access: `33_Security_and_Privacy.md` §8 (SELECT for `authenticated`; no client write). Migration: `20261010120000_product_barcode_foundation.sql`.

**Product** — `id` uuid PK (stable; future meal logs reference it) · `brand_name` text 1–200 · `product_name` text 1–300 · `variant_name` 1–200, nullable · `manufacturer_name` 1–200, nullable · `market` ISO 3166-1 alpha-2, nullable (same name in two markets = two Products) · `package_quantity` > 0 + `package_unit` (`g`|`ml`|`count`), both or neither — the package, never a serving · `food_id` nullable FK → Food (generic category only; never a nutrition/serving/density source) · `status` enum(`active`,`discontinued`) · `current_label_version_id` (composite FK → ProductLabelVersion of this product; maintained by trigger) · `source` enum `product_reference_source` (`manufacturer_data`,`approved_product_database`,`trusted_ingestion`) · `provenance_reference` ≤ 500 · `created_at`/`updated_at`. No retailer SKU, price, store or availability.

**ProductLabelVersion** — `id` · `product_id` · `version_number` int (1..n per product, trigger-assigned under an advisory lock) · `status` enum(`current`,`superseded`) — exactly one current per product (unique partial index) · `nutrition_source` enum `product_nutrition_source` (`manufacturer_label` — authoritative for the exact Product; `third_party_product_database` — stored, not authoritative) · `provenance_reference` · `effective_from` date, nullable · `superseded_at` / `superseded_by_label_version_id` (set together, once, when the next version is published) · `created_at` (publication time). Immutable except that one supersession (`product_label_version_immutable`). Published through the trusted-only `publish_product_label_version()` (not granted to clients).

**ProductNutrient** — `id` · `label_version_id` + `product_id` (composite FK) · `nutrient_id` FK → Nutrient (Layer 5C canonical vocabulary; no product-specific keys) · `amount` ≥ 0 in `Nutrient.unit` (0 = known zero; no row = unknown) · `basis_quantity` > 0 + `basis_unit` (`g`|`ml`) — explicit label basis (per 100 g, per 60 g bar, per 250 ml, per package in g/ml) · `source` (`product_nutrition_source`) · `provenance_reference` · `created_at`. Unique `(label_version_id, nutrient_id)`. Insert only by the transaction that created the version (`product_label_version_sealed`); no UPDATE. kJ-only label energy is not stored as `energy` (no approved conversion).

**ProductServing** — `id` · `label_version_id` + `product_id` · `serving_description` 1–200 (e.g. "1 bar") · `canonical_quantity` > 0 + `canonical_unit` (`g`|`ml`) — the amount of one serving · `source` · `provenance_reference` · `created_at`. Label-scoped; never written to FoodServing. Sealed and immutable like ProductNutrient.

**Barcode** — `id` · `product_id` FK (immutable) · `gtin` char 14, canonical, `gtin_is_product_identity()` (GS1 mod-10; not restricted-circulation `02`/`04`/`2x`, coupon `05`/`99`/`980–984`, variable-measure indicator `9`, or restricted EAN-8 `0`/`2`) · `barcode_type` enum(`ean_13`,`ean_8`,`upc_a`,`upc_e`,`gtin_14`) as submitted (`barcode_type_shape` keeps it consistent with the canonical form) · `status` enum(`active`,`retired`) · `retired_at` + `retired_reason` (set together on retirement) · `source` (`product_reference_source`) · `provenance_reference` · `created_at`. Unique active GTIN (`uq_barcode_active_gtin`). Only change: active → retired (`barcode_immutable`); never deleted, never re-pointed; a GTIN may be attached to another Product only as a new row by an authorized trusted workflow.

**FoodNutrient change (Layer 11A):** `food_nutrient_generic_reference_source` — new/updated rows must be `trusted_database` (added NOT VALID; legacy `manufacturer_label` rows are kept, cannot be updated in place, and still resolve per `30_API.md` §15).
