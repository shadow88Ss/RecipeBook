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
| field_name | text | not null | — | — | system_computed | must be in the fixed resolvable-field vocabulary (e.g. `calories`, `protein_g`, `fiber_g`, ...) | no | shared vocabulary with `ClinicianTarget.field_name` |
| value | numeric | not null | — | — | user_entered | plausible range per field | yes | — |
| unit | text | not null | — | — | user_entered | must match field's canonical unit | yes | — |
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
| field_name | text | not null | — | — | system_computed | shared vocabulary with `NutritionTarget.field_name` | no | — |
| value | numeric | not null | — | — | guardian_entered / user_entered | plausible/safety-bounded range | yes | — |
| unit | text | not null | — | — | guardian_entered / user_entered | must match canonical unit | yes | — |
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
| corrects_measurement_id | uuid | nullable | null | self-FK → WeightMeasurement | system_computed | — | no | correction pattern, mirrors `MealItem` |
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
| snapshot_reason | enum(`meal_consumed`,`daily_summary_finalized`,`coach_recommendation_issued`,`user_requested_export`,`manual_audit`) | not null | — | — | system_computed | fixed set | no | — |
| linked_event_type | enum(`consumed_meal`,`daily_summary_finalized`,`coach_recommendation`,`other_auditable_decision`) | nullable | null | — | system_computed | — | no | null when not anchored to one row |
| linked_event_id | uuid | nullable | null | — | system_computed | required if `linked_event_type` set | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Row is write-once; no update path exists for any field after insert (Master §8, approved design).

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
| logged_date | date | not null | — | — | user_entered / system_computed | profile-local date | yes (while items remain draft/planned) | — |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

Index: `(profile_id, logged_date)`.

---

## 13. MealItem

**Purpose:** an individual food/recipe item within a MealLog; the sole owner of meal lifecycle state (Master §6).
**PII:** no. **Health:** yes. **Child-sensitive:** conditional.
**Retention:** Master §14.2. **Deletion:** with Profile; consumed rows are not individually user-deletable except via the correction/cancel paths. **Export:** included. **Audit:** consumed-state corrections logged to `AuditEvent` (§29_Data_Model.md §3.3).

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| meal_log_id | uuid | not null | — | FK → MealLog | system_computed | — | no | index |
| profile_id | uuid | not null | — | FK → Profile (denormalized) | system_computed | must match parent MealLog's profile_id | no | direct RLS filter |
| recipe_version_id | uuid | nullable | null | FK → RecipeVersion | user_entered | — | at draft/planned only | mutually exclusive-ish with `food_id` (either a recipe or a raw food is logged) |
| recipe_personalized_variant_id | uuid | nullable | null | FK → RecipePersonalizedVariant | user_entered | — | at draft/planned only | — |
| food_id | uuid | nullable | null | FK → Food | user_entered / ai_derived | — | at draft/planned only | — |
| food_serving_id | uuid | nullable | null | FK → FoodServing | user_entered / ai_derived | — | at draft/planned only | — |
| quantity | numeric | not null | — | — | user_entered / ai_derived | positive | at draft/planned only | — |
| status | enum(`draft`,`planned`,`confirmed`,`consumed`,`skipped`,`cancelled`) | not null | `draft` | — | system_computed | transitions per `29_Data_Model.md` §3.2 only | via defined transition actions only, never a free-form field edit | canonical Phase 1 lifecycle enum |
| confirmed_at | timestamp | nullable | null | — | system_computed | set only on `planned → confirmed` | no | — |
| consumed_at | timestamp | nullable | null | — | system_computed | set only on `confirmed → consumed` | no | — |
| status_changed_by_actor_type | enum(`user`,`ai_optimizer`,`system`) | not null | `user` | — | system_computed | — | no | — |
| status_changed_by_account_id | uuid | nullable | null | FK → Account | system_computed | required if `status_changed_by_actor_type = user` | no | — |
| corrects_meal_item_id | uuid | nullable | null | self-FK → MealItem | system_computed | only settable when creating a correction row for a `consumed` item | no | — |
| superseded_by_meal_item_id | uuid | nullable | null | self-FK → MealItem | system_computed | set on the original when a correction is created | no | — |
| correction_reason | text | nullable | null | — | user_entered | required if `corrects_meal_item_id` set | at correction time only | — |
| created_at / updated_at | timestamp | not null | now() | — | system_computed | — | no | — |

Indexes: `(profile_id, meal_log_id)`, `(status)`.

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
| density_g_per_ml | numeric | nullable | null | — | trusted_database / manufacturer_label / ai_matched | positive; set together with `density_source` | no | Layer 5A. Only path for mass ↔ volume conversion; null = the food cannot be converted across dimensions (never assumed to be water) |
| density_source | enum(`trusted_database`,`manufacturer_label`,`user_entered`,`ai_matched`) | nullable | null | — | system_computed | non-null iff `density_g_per_ml` is non-null (`food_density_source_pairing`) | no | Layer 5A. Provenance of the density value itself, independent of `source` |
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
| alias_text | text | not null | — | — | trusted_database / ai_matched | — | no | AI-matched aliases require validation before becoming authoritative (Master §16) |
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
| serving_description | text | not null | — | — | trusted_database | — | no | locale-specific text |
| region | text | nullable | null | — | trusted_database | BCP 47 region/market subtag | no | null = region-agnostic |
| canonical_quantity | numeric | not null | — | — | trusted_database | positive | no | — |
| canonical_unit | text | not null | — | — | trusted_database | `g` or `ml` only (`food_serving_canonical_unit_base`, Layer 5A) | no | the two canonical base units of the conversion engine |
| source | enum(`trusted_database`,`user_entered`,`ai_matched`) | not null | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique: `(food_id, serving_description, region)`.

---

## 17. Nutrient

**Purpose:** canonical, language-neutral nutrient identity (Master §13.4). Localized display labels live in a separate `(nutrient_id, locale)` lookup, deferred to `06_Nutrition_Database.md` — not separately dictionaried here.
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** indefinite reference data. **Deletion:** not user-deletable. **Export:** n/a. **Audit:** curation changes logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| canonical_key | text | not null | — | — | trusted_database | e.g. `protein`, `fiber`, `vitamin_c` | no | unique |
| unit | text | not null | — | — | trusted_database | canonical unit (g/mg/mcg) | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

---

## 18. FoodNutrient

**Purpose:** a sourced nutrient amount for a Food, per canonical reference quantity (Master §16 — multiple sourced values coexist rather than overwriting).
**PII:** no. **Health:** no. **Child-sensitive:** no.
**Retention:** reference data. **Deletion:** curated. **Export:** n/a. **Audit:** curation changes logged.

| Field | Type | Null | Default | Key | Source | Validation | User-editable | Notes |
|---|---|---|---|---|---|---|---|---|
| id | uuid | not null | — | PK | system_computed | — | no | — |
| food_id | uuid | not null | — | FK → Food | system_computed | — | no | index |
| nutrient_id | uuid | not null | — | FK → Nutrient | system_computed | — | no | index |
| amount_per_canonical_unit | numeric | not null | — | — | trusted_database / manufacturer_label / ai_matched | non-negative | no | amount of the nutrient (in `Nutrient.unit`) per `basis_quantity` `basis_unit` of the food; column name kept from Layer 1 |
| basis_quantity | numeric | not null | 100 | — | trusted_database / manufacturer_label | positive | no | Layer 5A. Makes the reference basis explicit (previously only documented as "e.g. per 100g") |
| basis_unit | text | not null | `g` | — | trusted_database / manufacturer_label | `g` or `ml` | no | Layer 5A |
| source | enum(`trusted_database`,`manufacturer_label`,`user_entered`,`ai_matched`) | not null | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

Unique: `(food_id, nutrient_id, source)` — multiple sourced values per pair are intentional, not a conflict.

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
| current_version_id | uuid | nullable | null | FK → RecipeVersion | system_computed | must point to a version of this Recipe | no | convenience pointer to latest accepted version |
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
| unit | text | nullable | null | — | user_entered / ai_derived | — | no | — |
| match_confidence | numeric | nullable | null | — | ai_derived | present only when `food_id` was AI-matched | no | — |
| match_status | enum(`matched`,`needs_confirmation`,`unmatched`) | not null | `needs_confirmation` | — | system_computed | — | no | Master §16/§18 |
| sort_order | integer | not null | — | — | system_computed | — | no | — |
| created_at | timestamp | not null | now() | — | system_computed | — | no | — |

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

Carried forward in `29_Data_Model.md` §2's entity inventory but not dictionaried at field level here, because their full shape belongs to a later phase's own module spec and nothing in Phase 1 (auth, profile, session, targets, meal lifecycle, recipe versioning/personalization, import, AI provenance, wearable provenance, audit) depends on their field-level detail yet: `RecipeCategory`, `RecipeTag`, `RecipeRating` (→ `10_Recipe_Library.md`), `Product`, `Barcode` (→ `11_Barcode_and_QR.md`), `CycleRecord`, `PregnancyProfile`, `PostpartumProfile`, `BreastfeedingProfile` (→ `18_Womens_Nutrition_Intelligence.md`), `CoachRecommendation` (→ `13_Adaptive_Nutrition_Coach.md`), `NotificationPreference` (→ `28_Notifications.md`). Each must receive its own field-level dictionary pass, in the same format as this document, before its owning phase's migrations are written.
