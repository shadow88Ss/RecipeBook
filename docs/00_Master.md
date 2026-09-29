# 00_Master.md
# AI Nutrition Platform — Master Development & Implementation Authority

**Status:** AUTHORITATIVE
**Applies to:** All modules `01` through `37`, all source code, database migrations, APIs, mobile clients, workers, AI agents, tests, and deployment configuration.
**Companion document:** `README.md`

---

## 1. Purpose

This document is the implementation authority for the AI Nutrition Platform described in `README.md`.

The README defines **what the platform is** and its high-level architecture principles.

This file defines **how the platform must be implemented**, how conflicts between specifications are resolved, which technology decisions are fixed, how modules interact, and what Claude must do before changing established contracts.

Claude MUST read `README.md` and this document before implementing any module.

Claude MUST NOT treat a module file in isolation. Every implementation must remain consistent with:

1. `README.md`
2. `00_Master.md`
3. Approved cross-module contracts
4. The module-specific specification
5. Existing accepted migrations, APIs, tests, and source code

When conflicts exist, follow the authority order defined below.

---

# 2. Specification Authority Order

The authority hierarchy is:

1. `00_Master.md`
2. Security, privacy, clinical-safety, and child-safety requirements
3. Approved data model and API contracts
4. Module-specific MD specifications
5. README feature descriptions
6. Implementation details already present in source code

If existing code conflicts with an approved specification, Claude MUST flag the conflict and propose a migration/refactor. It MUST NOT silently preserve incorrect behavior.

If two authoritative requirements cannot both be satisfied, Claude MUST stop and report:

- the conflicting requirements;
- affected modules;
- recommended resolution;
- migration impact, if any.

Claude MUST NOT invent a hidden compromise.

---

# 3. Fixed Technology Stack

The following stack is the default approved implementation stack for the initial production version.

## 3.1 Mobile application

- **React Native**
- **Expo**
- **TypeScript**
- **Expo Router**
- iOS and Android from one shared application codebase
- Native integrations may use Expo modules or carefully isolated native modules when required

Do NOT switch to Flutter, native Swift/Kotlin, or another mobile framework without explicit approval.

## 3.2 Backend and shared language

Use **TypeScript end-to-end** wherever practical.

Backend responsibilities may be implemented using:

- Supabase platform services;
- server-side TypeScript functions/services;
- background workers where asynchronous processing is required.

Do NOT introduce a separate Python/FastAPI backend merely for preference. Python may be introduced later only where a specific approved workload justifies it.

## 3.3 Primary platform services

Use **Supabase** for the initial platform foundation:

- PostgreSQL database
- Authentication
- Row Level Security
- Storage
- server-side functions where appropriate
- realtime features only where genuinely required

The database is the source of truth for persistent application state.

## 3.4 API style

The application API is **REST-first** with typed request/response contracts.

GraphQL is NOT part of the initial implementation.

Internal TypeScript types alone are not sufficient as API contracts. External/service boundaries must have runtime validation.

Preferred pattern:

- versioned REST endpoints;
- explicit request/response schemas;
- validation at trust boundaries;
- stable error envelopes;
- generated/shared types where safe.

## 3.5 Validation and contracts

Use runtime schemas for externally supplied or cross-boundary data.

Recommended TypeScript validation approach: **Zod** unless an approved module requires another standard.

Never trust:

- mobile input;
- imported web content;
- AI output;
- wearable data;
- barcode/product data;
- third-party API responses

without validation/normalization.

## 3.6 Asynchronous work

Asynchronous ingestion, AI extraction, wearable sync, and other retryable work MUST use explicit durable job state.

For the initial implementation, prefer a PostgreSQL-backed queue/job mechanism compatible with Supabase (for example a queue extension/service supported by the selected Supabase environment).

Do not introduce Redis solely because a queue/cache is mentioned in architecture notes.

Redis or another dedicated cache/queue may be introduced later only when measured operational requirements justify it.

## 3.7 AI provider

Claude is the primary reasoning/extraction AI unless a module explicitly defines another provider.

AI provider access MUST occur server-side.

API keys MUST NOT be embedded in the mobile application.

---

# 4. Repository Structure

Prefer a monorepo so mobile, backend contracts, deterministic nutrition logic, and shared types remain aligned.

Logical structure:

```text
/apps
  /mobile
/services
  /api
  /workers
/packages
  /contracts
  /nutrition-core
  /shared
  /ui
/supabase
  /migrations
  /functions
/tests
/docs
```

Exact folder details may evolve, but Claude MUST preserve these boundaries:

- mobile UI must not contain authoritative nutrition calculations;
- AI prompts/agents must not contain authoritative nutrition calculations;
- shared contracts must not depend on UI code;
- database migrations must be version controlled;
- secrets must remain server-side.

---

# 5. Core Architecture Rule: AI Reasons, Deterministic Services Calculate

This is a non-negotiable platform rule.

Claude/AI may:

- interpret free text;
- interpret speech transcripts;
- interpret images;
- extract ingredients and quantities;
- classify foods;
- propose food matches;
- explain results;
- suggest meal adjustments;
- generate meal ideas;
- reason over deterministic results;
- provide confidence and uncertainty.

Claude/AI MUST NOT be the authoritative calculator for:

- calories;
- macronutrients;
- micronutrients;
- fiber;
- unit conversion;
- serving conversion;
- energy-target formulas;
- nutrient aggregation;
- target precedence;
- remaining daily totals.

Those values MUST be produced by deterministic services using stored/reference data and explicit formulas.

Every AI-derived structured value MUST be validated before persistence.

Every inferred value requiring provenance MUST retain:

- source;
- inference/extraction method;
- confidence;
- timestamps/version information where applicable.

---

# 6. Meal Lifecycle and Optimization Rules

This section resolves the planned-meal ambiguity.

A meal/meal-plan item has an explicit lifecycle.

Minimum semantic states:

1. `draft`
2. `planned`
3. `confirmed`
4. `consumed`
5. `skipped` or `cancelled` where applicable

## 6.1 Draft

A draft may be freely regenerated or optimized.

## 6.2 Planned

A planned meal may be optimized automatically while it has NOT been explicitly confirmed by the user.

The UI must make it clear that it is a proposal.

## 6.3 Confirmed

A confirmed planned meal is **user-approved intent**.

The system MUST NOT silently replace or materially alter:

- recipe;
- ingredients;
- serving size;
- scheduled meal;
- user-entered nutrition values

after confirmation.

The coach may identify that a confirmed meal no longer fits the current target and may offer an alternative or adjustment, but the change requires explicit user acceptance.

## 6.4 Consumed

A consumed meal is historical truth.

It MUST NEVER be retroactively optimized or silently changed.

Corrections are allowed only through an explicit user-edit/correction flow that preserves appropriate audit/provenance information.

## 6.5 Optimizer eligibility

Automatic optimizer eligibility:

- `draft`: YES
- `planned`: YES
- `confirmed`: NO; suggestion only, user approval required
- `consumed`: NO
- `skipped/cancelled`: NO

This state rule applies across Meal Planning, Adaptive Nutrition Coach, Daily Tracker, and AI agents.

## 6.6 Amendment — planning and consumption are separate records (Phase 2 Layer 8A)

The lifecycle above is realized by **two separate domains**, never by one row moving from intent to consumption:

- **Planned intent** — `MealPlan → MealPlanDay → PlannedMeal → PlannedMealItem`. A PlannedMealItem moves `draft → planned → confirmed`, or to `cancelled`; a confirmed item is immutable and is changed only by an explicitly accepted **replacement** item (supersession). The optimizer rules of §6.5 apply to PlannedMealItems (`draft`/`planned`: may be optimized with user awareness; `confirmed`: suggestion only).
- **Actual consumption** — `MealLog → MealItem` with status `consumed` plus the approved correction/supersession history (Layer 7A).

A PlannedMealItem never becomes `consumed`; consumption is recorded only as a MealItem. The link between a planned item and the actual MealItem(s) that fulfil it is defined by a later layer (8B) without changing either record. The `draft/planned/confirmed/skipped/cancelled` values remain in the MealItem status enum for compatibility but are not used by the official actual-logging API.

## 6.7 Grocery Planning — generated requirements (Phase 2 Layer 9A)

Grocery requirements are **derived deterministically from planned intent** — never from nutrition values, the Daily Tracker, actual consumption or adherence, and never by AI:

- **Source:** a MealPlan's current planned items — a direct Food amount, or the exact RecipeVersion stored on the PlannedMealItem (never `Recipe.current_version_id`) expanded into its structured RecipeIngredients and scaled by `planned servings ÷ yield`. Cancelled, superseded, pending-replacement and actively skipped items do not contribute.
- **Normalization and aggregation:** Layer 5A exact conversion into the canonical grocery bases `g`, `ml`, `count`; aggregation only by canonical Food id + compatible dimension (mass + volume only through the Food's trusted density; count never with mass/volume). Anything that cannot be reconciled or resolved is kept as an explicit unresolved requirement — never dropped, never guessed.
- **Lifecycle:** a draft plan has a preview only (`unconfirmed_plan_preview`); an active plan has a preview and **persisted, immutable GroceryList generations** built from current *confirmed*, non-skipped items (unconfirmed items reported as excluded). Regeneration creates a new generation and supersedes the previous one atomically; nothing is edited or deleted. A list whose plan sources have changed is reported `is_stale`; it is not changed. Completed, cancelled and archived plans get no new preview or generation; their lists stay readable.
- **Boundary:** a generated list contains generated requirements only. User shopping state (already-have, purchased, manual items, edited quantities, carry-forward on regeneration) belongs to Layer 9B in separate records that reference — never overwrite — the generated baseline. Retailer products, prices, carts, pantry inventory and AI optimization/substitution are out of scope until their own layers.

## 6.8 Grocery workflow — user shopping state (Phase 2 Layer 9B)

"What the plan requires" (9A, generated, immutable) and "what I actually need to buy / have bought" (9B, user facts) are **separate records**; a user action never changes a generated requirement.

- **User facts, per GroceryList generation:** already-have quantity, an optional shopping-quantity adjustment (the amount the user intends to buy), purchase events (quantity, or a plain check-off for a requirement without a quantity), and manual items (food or non-food; a manual Food item stays manual — never plan provenance).
- **Derived at read time (Layer 5A units, exact):** `derived_need = max(generated − already_have, 0)`, `shopping_target = adjustment or derived_need` (source `generated` / `user_adjusted`), `remaining = max(target − purchased, 0)`, with surplus/over-purchase reported factually and statuses `need_to_buy`, `partially_purchased`, `purchased`, `already_have_sufficient`, `no_purchase_needed`, `comparison_unresolved`. Incomparable quantities (count vs mass, mass vs volume without trusted density, unresolved requirements) are shown, never counted, never fabricated.
- **History:** append + revoke only (setting a value revokes the previous one; clear/remove/undo revoke). Nothing is edited or deleted.
- **Generations:** state belongs to the generation it was recorded on. It is **never carried forward**: a regenerated list starts clean; the previous generation keeps its state, read-only. State is writable only on the current generation of an active or completed plan.
- **Out of scope:** retailers, products, prices, availability, carts, checkout, delivery, barcode shopping, pantry inventory, AI optimization/substitution.

---

# 7. Account, Authentication, Profile, and Session Model

## 7.1 Identity model

Authentication identifies the **Account**.

The Account is the authenticated security principal.

A Profile identifies **whose nutrition context is currently being accessed**.

An Account may have one or more permitted Profiles.

## 7.2 Session model

Use the authentication provider's secure access/refresh token model.

For the initial stack, Supabase Auth owns authentication token issuance and refresh.

Application-level `DeviceSession` records may store/manage device/session metadata needed for:

- session listing;
- revocation;
- logout-all;
- device awareness;
- last activity;
- security events.

Do NOT invent a second competing password/token system.

## 7.3 Profile context at API layer

Use:

- authenticated Account token; plus
- an explicit active `profile_id` supplied with the request according to the API contract.

The server MUST validate on every profile-scoped request that the authenticated Account has permission to access the supplied Profile.

Never trust a `profile_id` simply because the mobile client supplied it.

Do NOT mint a separate authentication token for every profile in the initial implementation.

## 7.4 Child authentication

In the initial version, a child Profile does **not** independently authenticate.

Child profiles are accessed through an authorized parent/guardian Account and profile-selection flow.

Sensitive child actions may require a parental gate/re-authentication as specified by child/privacy modules.

Independent child/teen login is outside the initial scope unless explicitly approved in a later specification.

---

# 8. Effective Nutrition Target Ownership and Precedence

There MUST be a single deterministic service responsible for computing the target currently applicable to a Profile.

Working name:

**EffectiveTargetResolver**

The final implementation name may follow repository conventions, but ownership must remain singular.

The resolver MUST NOT be implemented separately in multiple screens or AI prompts.

## 8.1 Precedence

Targets are resolved **field-by-field**, not simply by replacing an entire target object.

General order:

1. mandatory clinical/safety constraints applicable to the profile/life stage;
2. active clinician-defined target values, when present and permitted;
3. explicit valid user-defined targets;
4. profile-derived/default targets.

A lower-precedence source fills fields that are not defined by a higher-precedence source.

All resolved targets must still pass safety validation.

For pediatric profiles, pediatric safety and growth rules are mandatory and adult dieting logic must never be used as fallback.

## 8.2 Provenance

The effective target response MUST identify the provenance of each material target value so the app can explain whether it came from:

- clinician target;
- user target;
- profile calculation;
- life-stage/safety rule.

The AI coach consumes the resolved effective target. It does not independently decide precedence.

---

# 9. Clinician-Defined Targets

A value labeled "clinician-defined" must not be fabricated by AI.

It may originate only from an explicit supported workflow, such as:

- direct clinician-authorized integration in a future release; or
- user/guardian entry of a target explicitly marked as clinician-provided, where the product allows it.

If clinician identity is not verified by the platform, the UI/data model MUST NOT imply that the platform verified the clinician.

Clinical target provenance must remain distinguishable from ordinary user preferences.

---

# 10. Child Data Minimization and Pediatric Weight Management

Child data requires stricter handling, but "minimal data" does not mean the platform cannot store data required to deliver an explicitly enabled pediatric feature.

## 10.1 Data minimization rule

For child profiles, collect and retain only data that is:

- required to provide an enabled child feature;
- required for safety;
- required for legal/compliance obligations;
- explicitly provided with appropriate guardian authorization.

Do not collect optional child data merely because it may be useful later.

## 10.2 Pediatric weight-management carve-out

When a parent/guardian explicitly enables a supported pediatric weight-management workflow, the platform may store the minimum longitudinal data required for that workflow, potentially including:

- anthropometric measurements;
- relevant target information;
- growth/safety context;
- measurement dates;
- provenance.

This is not a waiver of minimization.

Each child-data field still requires a documented purpose, access rule, retention rule, and deletion/export behavior.

## 10.3 Product behavior

The system must avoid adult-style aggressive weight-loss logic for children.

Child recommendations must prioritize:

- adequate nutrition;
- growth and development;
- age-appropriate guidance;
- safety escalation where required.

No AI agent may bypass pediatric safeguards.

---

# 11. Recipe Source, Version, and Personalization Semantics

These concepts are distinct.

## 11.1 Base Recipe

Represents the normalized recipe derived from a user-created or imported source.

## 11.2 Recipe Version

Represents revision/history of the base recipe itself.

Versioning is used for meaningful changes to the canonical recipe representation while preserving history/provenance.

## 11.3 Personalized Recipe Variant

A personalized variant is NOT simply a destructive edit of the base recipe.

It is a profile-specific derivative that references the base recipe/base version and stores the user's approved substitutions, portions, or adjustments.

The detailed entity design belongs in `29_Data_Model.md`, but the model MUST preserve:

- immutable/provenanced source information;
- base recipe identity;
- base recipe version;
- profile-specific variant identity;
- explicit user acceptance of material AI-generated changes.

Personalization must never overwrite imported raw content.

---

# 12. Import Idempotency and Deduplication

Imports MUST be idempotent and traceable.

The detailed tables belong in `29_Data_Model.md`, but the implementation MUST support the following concepts:

- canonicalized source URL where applicable;
- source/provider identifier;
- import job identifier;
- idempotency key;
- raw content hash/content fingerprint;
- processing status;
- retry count;
- created/updated timestamps;
- linkage between raw input and normalized extraction;
- extraction/model version where AI is involved.

A repeated request for the same operation must not silently create duplicate recipes or duplicate raw-source records when the platform can reliably identify it as the same import.

Deduplication must distinguish between:

- the same source being processed twice;
- the same content published at multiple sources;
- a genuinely updated source.

Do not rely solely on URL equality.

---

# 13. Localization / Internationalization Data Rules

Localization must be designed into the data layer before finalizing the food schema.

## 13.1 Canonical data

Canonical food and nutrient identifiers must be language-independent.

## 13.2 Food names and aliases

Food aliases/display names must support locale metadata using a standard locale form such as BCP 47 (`en`, `en-AE`, `ar-AE`, etc.).

## 13.3 Regional servings and units

Serving descriptions may include locale/region applicability when serving conventions differ by market.

Underlying normalized quantities must use deterministic canonical units.

## 13.4 Nutrients

Nutrient identity must not be duplicated per language.

Localized nutrient display labels belong in localization/display data, not separate nutrient records.

## 13.5 User-entered language

Store original user/source text where provenance requires it, separately from normalized canonical representation.

---

# 14. Data Retention Authority

Every persistent data category must have:

- purpose;
- sensitivity classification;
- retention rule;
- deletion behavior;
- export behavior;
- legal/safety exception if applicable.

Detailed retention matrices belong in the Security/Privacy and Data Dictionary specifications.

Until jurisdiction-specific legal requirements are approved, use these product rules:

## 14.1 Account/profile data

Retain while the account/profile is active and needed for the service.

On verified deletion request, delete or irreversibly anonymize according to the approved deletion workflow, except where retention is legally required.

## 14.2 Consumed nutrition history

Retain while the profile is active because it powers history and analytics.

Delete/anonymize with profile deletion subject to legal requirements.

## 14.3 Child data

Apply stricter minimization and deletion behavior.

Do not retain child data indefinitely merely for analytics/model improvement.

## 14.4 Raw imported external content

Raw imported content is operational/provenance data, not an unlimited archival copy.

Retain only while it is needed for:

- extraction verification;
- provenance;
- user-requested saved content;
- dispute/debug window where permitted.

The detailed retention period MUST be set before production release and must consider copyright/platform restrictions.

## 14.5 Logs

Application/security logs should exclude raw health/nutrition content wherever possible.

Production log retention must be explicitly configured and documented before release.

## 14.6 AI training

User health, nutrition, child, pregnancy, or family data MUST NOT be repurposed for model training by this application unless a separate explicit approved consent and governance mechanism exists.

No such training use is assumed in the initial version.

---

# 15. Privacy and Sensitive Data

The platform processes potentially sensitive nutrition, activity, family, women's-health, pregnancy, breastfeeding, child, and health-context information.

Requirements:

- explicit consent/opt-in where required;
- least privilege;
- encryption in transit and at rest;
- Row Level Security;
- no secrets in clients;
- no sensitive values in analytics/logging by default;
- deletion/export support;
- purpose limitation;
- profile-level authorization;
- guardian controls for child profiles.

AI prompts must receive only the minimum context required to perform the task.

---

# 16. Nutrition Data Source Rules

Authoritative nutrient values must come from approved trusted food/product sources or explicit user-entered labels.

The database must preserve source/provenance sufficient to distinguish:

- trusted database values;
- manufacturer/product label values;
- user-entered values;
- inferred/matched values.

AI may identify a probable match but may not fabricate an authoritative nutrient record.

When uncertainty materially affects nutrition calculations, the user should be asked to confirm or choose among reasonable matches.

---

# 17. Wearable Data Rules

Wearable integrations are external data sources and must be treated as potentially delayed, duplicated, missing, or revised.

Every sync must support:

- provider identity;
- source record identity where available;
- timestamps/timezones;
- idempotent upsert;
- sync cursor/checkpoint where applicable;
- provenance;
- retry/failure handling.

Wearable-derived energy expenditure is an input to coaching, not unquestionable ground truth.

The UI/coach must be capable of explaining uncertainty where appropriate.

---

# 18. Error and Confidence Model

Do not hide uncertainty.

All modules that infer, match, import, or sync data must distinguish at least:

- success;
- partial success;
- needs user confirmation;
- retryable failure;
- permanent/unsupported failure.

AI confidence is not equivalent to factual correctness.

Confidence thresholds and escalation behavior must be defined in the relevant module and `32_AI_Confidence_and_Explainability.md`.

Low-confidence values that materially affect nutrition totals must not be silently accepted as certain.

---

# 19. API Rules

All APIs must:

- authenticate before private data access;
- authorize Account → Profile access server-side;
- validate requests;
- return typed/versioned responses;
- provide stable error codes;
- support idempotency for applicable write operations;
- avoid exposing internal stack traces;
- log safely;
- be testable independently from the mobile UI.

API versioning should begin with `/v1` or the equivalent project convention.

Do not expose database tables directly to untrusted clients unless the access pattern has an explicit RLS-backed design and has been approved.

---

# 20. Database and Migration Rules

The database schema is finalized through `29_Data_Model.md`, not invented ad hoc by feature modules.

Rules:

- migrations are append-only once accepted/shared;
- never edit production-applied migrations in place;
- use stable identifiers;
- use timestamps consistently;
- use explicit foreign keys;
- enforce invariants in the database where practical;
- use RLS for profile/account isolation;
- store provenance for inferred/imported data;
- avoid duplicating the same business concept in multiple tables;
- document retention/sensitivity for applicable fields/entities.

Before adding a table or field, Claude must search the existing schema/contracts for an existing owner.

---

# 21. No Silent Duplication Rule

Before creating any of the following, Claude MUST inspect the repository for an existing equivalent:

- entity/table;
- API endpoint;
- service;
- calculation;
- hook;
- shared type;
- UI component;
- AI agent;
- import worker;
- validation schema.

If an equivalent exists, extend/refactor it rather than creating a parallel implementation unless there is an explicit architectural reason.

---

# 22. Mobile Application Rules

The mobile application is a client of platform capabilities.

It may perform:

- presentation logic;
- local form validation;
- navigation;
- optimistic UI where safe;
- secure session storage;
- local caching;
- accessibility behavior.

It must not become the sole authority for:

- target calculation;
- nutrition calculations;
- authorization;
- health/child safeguards;
- import processing;
- AI provider calls.

Critical rules must be enforceable server-side.

Consumed-meal writes (Phase 2 Layer 7A): official clients create meals, meal items and corrections only through the `/v1` API and submit consumption facts (Food or exact RecipeVersion, quantity, unit/serving, `consumed_at`, meal context) — never nutrition values and never a `nutrition_snapshot`. The API's deterministic engine computes the historical nutrition snapshot. The resulting guarantee is *application-authoritative*, not cryptographically attested (`30_API.md` §18, `33_Security_and_Privacy.md` §10).

---

# 23. Offline and Caching Philosophy

Do not make full offline-first behavior a hidden requirement.

The initial application may cache appropriate read data and draft user input for resilience.

Any offline write that can affect authoritative totals must reconcile through explicit server synchronization and idempotency.

Never allow stale local authorization state to bypass server-side access controls.

---

# 24. Accessibility and UX Baseline

The mobile UI must be designed for:

- readable text;
- accessible labels;
- scalable text where practical;
- adequate touch targets;
- clear error/empty/loading states;
- confirmation for destructive actions;
- explicit distinction between AI suggestions and confirmed user data.

Never use dark patterns to pressure users into health goals, child weight changes, subscriptions, or data sharing.

---

# 25. Safety Boundaries

The application is a nutrition/wellness platform and must not pretend that AI-generated guidance is a medical diagnosis or emergency service.

Relevant modules must define when the system:

- provides general nutrition guidance;
- limits recommendations;
- displays caution;
- recommends professional review;
- declines unsafe personalization.

Pregnancy, breastfeeding, pediatric, clinician-target, and other safety-sensitive contexts must use dedicated rules.

AI cannot override deterministic safety gates.

---

# 26. Implementation Phases

Claude must build in controlled phases.

## Phase 0 — Foundation Review

Documents:

- `README.md`
- `00_Master.md`

Action:

- read;
- cross-reference;
- report conflicts/missing inputs;
- NO production feature implementation yet.

## Phase 1 — Platform Foundation

Documents:

- `29_Data_Model.md`
- `30_API.md`
- `33_Security_and_Privacy.md`
- `37_Authentication_and_Login.md`

Outputs:

- approved logical data model;
- API contract conventions;
- authentication/profile access model;
- RLS/security model;
- migration plan;
- foundation tests.

Do not begin broad feature implementation until Phase 1 contracts are coherent.

## Phase 2 — Deterministic Nutrition Foundation

Documents:

- `01_User_Profile.md`
- `02_Nutrition_Targets.md`
- `04_Universal_Food_Intelligence.md`
- `05_Universal_Conversion_Engine.md`
- `06_Nutrition_Database.md`
- `07_Nutrition_Calculation.md`

Outputs must include deterministic tests.

## Phase 3 — Core Food Logging

Documents:

- `03_Multimodal_Food_Logging.md`
- `11_Barcode_and_QR.md`
- `12_Daily_Tracker.md`

## Phase 4 — Recipes and Ingestion

Documents:

- `08_URL_Content_Ingestion.md`
- `09_Recipe_Intelligence.md`
- `10_Recipe_Library.md`

## Phase 5 — Core Mobile Experience

Documents:

- `22_Mobile_Application.md`
- `24_Dashboard.md`
- `27_Preferences_and_Personalization.md`
- `28_Notifications.md`

## Phase 6 — Wearables and Energy

Documents:

- `14_Activity_and_Energy_Coach.md`
- `15_Wearable_Integrations.md`

## Phase 7 — Nutrition Intelligence

Documents:

- `16_Micronutrient_Intelligence.md`
- `17_Fiber_Intelligence.md`
- `23_Analytics_and_Insights.md`

## Phase 8 — AI Coach and Planning

Documents:

- `13_Adaptive_Nutrition_Coach.md`
- `25_Search_and_AI_Query.md`
- `26_Meal_Planning.md`
- `31_Claude_AI_Agents.md`
- `32_AI_Confidence_and_Explainability.md`

## Phase 9 — Women's and Family Features

Documents:

- `18_Womens_Nutrition_Intelligence.md`
- `19_Family_and_Multi_Profile.md`
- `20_Child_Nutrition.md`
- `21_Pediatric_Weight_Management.md`

## Phase 10 — Release Quality Gate

Documents:

- `34_Clinical_and_Nutrition_Safety.md`
- `35_Testing_and_Quality.md`
- `36_Acceptance_Criteria.md`

No production release until the quality gate passes.

---

# 27. Phase Gate Procedure

For each phase Claude MUST:

1. Read all files assigned to the phase before coding.
2. Cross-reference them against README, Master, current schema, APIs, and prior accepted code.
3. Report:
   - conflicts;
   - ambiguous requirements;
   - proposed contract changes;
   - migration impact;
   - dependencies.
4. Wait for user approval if a material architecture/schema/API contract change is required.
5. Implement only the approved phase.
6. Run applicable:
   - type checks;
   - lint;
   - unit tests;
   - integration tests;
   - migration validation;
   - security/RLS tests.
7. Report completion using the format below.
8. Do not begin the next phase without explicit instruction.

---

# 28. Claude Completion Report

At the end of each implementation batch, Claude must provide:

## Implemented
What was actually completed.

## Files Changed
Important files created/modified.

## Database Changes
Migrations/entities/policies affected.

## API Changes
Endpoints/contracts affected.

## Tests
Tests added and their results.

## Security/Safety
Relevant authorization, RLS, privacy, clinical, pediatric, or AI-safety checks.

## Remaining
Anything intentionally incomplete.

## Risks / Decisions Needed
Any issue requiring user approval.

## Next Recommended Step
Exactly one recommended next implementation step.

Claude MUST NOT claim "complete" if:

- placeholders remain;
- mocks are used where production integration was required;
- tests are failing;
- required acceptance criteria are unverified.

---

# 29. Prototype / Existing Code Policy

Existing prototype code is reference material, not automatically authoritative architecture.

Before reusing prototype code, evaluate it against:

- current data model;
- current API contracts;
- authentication;
- RLS/security;
- deterministic nutrition rules;
- recipe provenance/versioning;
- mobile architecture.

Reusable logic/components may be migrated.

Do NOT preserve prototype structure when it conflicts with the approved architecture.

Do NOT create a second independent recipe system simply because a prototype already exists.

---

# 30. Secrets and Configuration

All secrets must be externalized.

Never commit:

- Claude/Anthropic API keys;
- Supabase service-role keys;
- OAuth client secrets;
- wearable provider secrets;
- signing secrets.

Use environment-specific configuration.

The mobile client may contain only values intended to be public/client-side, such as appropriate public project identifiers/anon keys under RLS-based security.

---

# 31. Observability

Production services must support sufficient observability to diagnose failures without exposing sensitive content.

Use:

- structured events/logs;
- request/job correlation identifiers;
- import/sync job status;
- safe error codes;
- metrics where useful.

Do not log full health records, child data, raw images, full imported captions/transcripts, tokens, or secrets by default.

---

# 32. Testing Rules

At minimum, testing must cover:

## Deterministic nutrition
- unit conversions;
- serving conversions;
- calorie/macronutrient aggregation;
- micronutrient aggregation;
- target resolution;
- rounding rules.

## Data/security
- Account/Profile isolation;
- guardian/child access;
- RLS;
- unauthorized profile-id attempts;
- deletion/export paths.

## Imports
- duplicate submissions;
- retries;
- partial extraction;
- content changes;
- invalid/unsupported sources.

## AI
- schema-invalid output;
- low confidence;
- hallucinated food candidates;
- missing quantities;
- refusal/safety behavior.

## Meal lifecycle
- optimizer state eligibility;
- confirmed meal protection;
- consumed-history immutability.

Critical calculation and authorization logic must not rely solely on snapshot/UI tests.

---

# 33. Definition of Done

A module is not done merely because the happy-path screen works.

A feature is complete only when applicable requirements include:

- functional implementation;
- persisted data;
- authorization;
- validation;
- failure behavior;
- loading/empty/error UX;
- tests;
- security/privacy handling;
- provenance/confidence handling;
- accessibility basics;
- no critical TODO placeholders;
- acceptance criteria satisfied.

---

# 34. Decisions Claude Must Not Make Independently

Claude must request approval before:

- changing the approved technology stack;
- replacing Supabase;
- changing REST to GraphQL;
- introducing a new database;
- introducing a new independent auth system;
- materially changing Account/Profile security semantics;
- weakening child/privacy/safety controls;
- changing target precedence;
- changing meal lifecycle semantics;
- replacing deterministic calculations with AI;
- performing a breaking API/schema migration without a migration plan;
- deleting accepted functionality;
- introducing paid third-party infrastructure that materially changes operating cost.

Minor implementation details consistent with approved contracts do not require approval.

---

# 35. Current Architectural Decisions Summary

The following questions are considered RESOLVED by this Master document:

| Question | Decision |
|---|---|
| Mobile framework | React Native + Expo + TypeScript |
| Backend language | TypeScript-first |
| Primary platform | Supabase/PostgreSQL |
| API style | REST-first, typed contracts |
| Auth | Supabase Auth |
| Profile access | Account token + server-validated `profile_id` |
| Child login | Parent/guardian-gated; no independent child auth initially |
| Session | Auth provider tokens + application DeviceSession metadata/revocation |
| Target owner | Single deterministic EffectiveTargetResolver |
| Target precedence | Safety/clinical → clinician → user → derived/default, field-level |
| Confirmed planned meals | Frozen from silent optimization; suggestions require approval |
| Consumed meals | Historical truth; only explicit correction |
| Personalized recipes | Profile-specific derivative, not destructive base edit |
| Import dedup | URL/provider + idempotency + content fingerprint + durable job state |
| Localization | Language-neutral canonical entities + locale-aware aliases/display data |
| Child minimization | Feature-purpose-based minimum data, including explicit pediatric workflow needs |
| Queue | Durable PostgreSQL/Supabase-compatible job queue first |
| Redis | Not required initially |
| AI calculations | Prohibited as authoritative nutrition calculation mechanism |

---

# 36. Instructions to Claude Immediately After Receiving This File

After reading `README.md` and `00_Master.md`:

1. Do NOT start coding.
2. Cross-reference this Master against all specification fragments currently available in the workspace.
3. Identify only:
   - direct contradictions with this Master;
   - module files that must be updated because this Master resolves an ambiguity;
   - any remaining decision that genuinely blocks Phase 1.
4. Do not reopen a decision already fixed in Section 35 unless implementing it would create a concrete technical or safety failure.
5. Return a concise **Foundation Readiness Report**.
6. Wait for the user to provide/approve Phase 1 files:
   - `29_Data_Model.md`
   - `30_API.md`
   - `33_Security_and_Privacy.md`
   - `37_Authentication_and_Login.md`

Do not begin Phase 1 implementation until explicitly instructed.

---

# 37. Foundation Readiness Report Format

Claude should respond in this structure:

```text
FOUNDATION READINESS

Status:
READY / READY WITH DOCUMENT UPDATES / BLOCKED

Master conflicts:
- ...

Specifications requiring alignment:
- ...

Remaining blocking decisions:
- ...

Non-blocking items to resolve in later modules:
- ...

Recommended next action:
- ...
```

If there is no true blocker, Claude should say so and recommend proceeding to Phase 1 specification review.

---

# 38. Final Rule

When uncertain:

**Preserve user data, preserve provenance, preserve security boundaries, preserve historical truth, prefer deterministic calculations, expose uncertainty, and ask before making a breaking architectural decision.**
