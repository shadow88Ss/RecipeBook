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
| Child Profile | `Profile` (child), `ChildProfileExtension`, `GuardianAuthorization` | Stricter minimization (Master §14.3); no indefinite retention for analytics/model-improvement purposes | Deleted on guardian-verified deletion request; `GuardianAuthorization` revocation itself is retained briefly as an audit record of the revocation event, not as ongoing access | Guardian-initiated export only |
| Health/clinical | `WeightMeasurement`, `ClinicianTarget`, `PregnancyProfile`, `PostpartumProfile`, `BreastfeedingProfile`, `CycleRecord` | While profile active; child instances follow the Child Profile row above | Deleted/anonymized with profile deletion | Included in profile/guardian export |
| Nutrition history | `MealLog`, `MealItem`, `EffectiveTargetSnapshot` | While profile active — powers history/analytics (Master §14.2) | Deleted/anonymized with profile deletion | Included in profile export |
| Raw imported content | `RawContent`, `UrlSource`, `ImportJob` | Operational/provenance window only — extraction verification, provenance, user-requested saved content, or a bounded dispute/debug window; **not** unlimited archival (Master §14.4) | Purged per the retention window even without a deletion request; also purged on profile/account deletion | Not included in standard export beyond what the user explicitly saved as a Recipe |
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
