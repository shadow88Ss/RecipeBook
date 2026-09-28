# 30_API.md
# Phase 1 — API Architecture

**Status:** Phase 1 specification — API conventions and contracts. No endpoints are implemented yet.
**Authority:** Subordinate to `00_Master.md`. Where anything below appears to conflict with `00_Master.md`, the Master controls.
**Supersedes:** `API_ARCHITECTURE.md`, `ANALYTICS_API.md` (retained under `docs/fragments/` as historical source material; `API_ARCHITECTURE.md`'s REST/GraphQL wording is superseded by §2 below).

---

## 1. Purpose

This document fixes the API conventions every Phase 1+ service boundary must follow: style, versioning, validation, authorization, error/response shape, and idempotency. Module-specific endpoints (food logging, recipes, analytics, etc.) are defined in their own phase documents and must conform to this contract.

---

## 2. API Style

- **REST-first.** GraphQL is explicitly out of scope for the initial implementation (Master §3.4).
- Endpoints are versioned starting at `/v1`.
- Every service boundary — mobile ↔ backend, backend ↔ AI provider, backend ↔ third-party (wearables, barcode/product data) — has an explicit typed request/response schema. Internal TypeScript types alone are not a contract; they must be backed by runtime validation.

---

## 3. Runtime Validation

- All externally supplied or cross-boundary data is validated at the trust boundary using **Zod** (or an approved equivalent named by a specific module).
- "Externally supplied" includes, per Master §3.5: mobile input, imported web content, AI output, wearable data, barcode/product data, and third-party API responses. None of these are trusted unvalidated.
- Validation failures return a typed error response (§6), never an unhandled exception or a raw stack trace.

---

## 4. Authentication and Authorization

- Every private endpoint requires an authenticated Supabase Auth Account token. Unauthenticated requests to private data are rejected before any business logic runs.
- Profile-scoped endpoints additionally require an explicit `profile_id` supplied per the endpoint's contract (query param, path param, or body field as appropriate to the route).
- **The server MUST validate, on every profile-scoped request, that the authenticated Account is permitted to access the supplied `profile_id`** — via direct ownership (`Account 1..N Profile`) or, for a child profile, an active `GuardianAuthorization` record (see `29_Data_Model.md` §11). This check happens server-side on every request; it is never inferred from the client having previously been shown the profile, and never skipped because the client "already knows" the profile is theirs.
- **A client-supplied `profile_id` is never trusted by itself.** Supplying a `profile_id` the Account is not authorized for returns an authorization error, not a data leak and not a silent fallback to a default profile.
- No endpoint mints or accepts a separate authentication token per profile (Master §7.3). Profile context rides alongside the single Account token.

---

## 5. Versioned, Typed, Stable Contracts

- Path convention: `/v1/<resource>`. A breaking change to a resource's contract requires a new version segment or an explicit, documented migration plan — never an in-place silent breaking change to `/v1`.
- Request and response bodies are defined by an explicit schema (Zod) per endpoint, and that schema is the source of truth for both server-side validation and any generated/shared client types.
- Responses are typed at the field level — no endpoint returns an untyped/opaque blob for data the mobile client depends on.

---

## 6. Standard Response and Error Envelope

- Successful responses return the typed resource/result directly (or a typed wrapper if pagination/metadata is required — see §8).
- Error responses use a stable, consistent envelope across all endpoints: a stable machine-readable error code, a human-readable message safe to display or log, and no internal stack trace or implementation detail.
- Error categories map to the Master §18 status model where applicable (e.g. a food-match/import endpoint may return `needs_confirmation` as a defined outcome, not as an HTTP error — matching the canonical `needs_confirmation` naming used by `ImportJob.processing_status` and `AiExtraction.status` in `29_Data_Model.md` §7.3/§9).
- Distinct, stable error codes exist for at least: validation failure, unauthenticated, unauthorized (Account/Profile mismatch), not found, conflict/idempotency violation, retryable upstream failure, permanent upstream failure.

---

## 7. Idempotency

- Write operations that can be safely retried by the client (imports, wearable sync triggers, and any other operation backed by durable job state per Master §3.6/§12) accept an idempotency key and return the same logical result on retry rather than creating a duplicate resource.
- Import endpoints specifically key off `ImportJob.idempotency_key`, the parent `UrlSource.canonical_url`, and the attempt's `content_fingerprint`, per the finalized `UrlSource`/`ImportJob` split in `29_Data_Model.md` §7 — a repeated request for the same source resolves to the existing `UrlSource` and either the existing `ImportJob` (same idempotency key) or a new `ImportJob` against it (retry/re-import), never a duplicate `UrlSource` or `Recipe`.
- Wearable sync endpoints/workers use `WearableConnection.sync_cursor` and `(wearable_connection_id, provider_record_id)` upsert keys (per `29_Data_Model.md` §8) to guarantee idempotent ingestion.

---

## 8. Pagination

- List endpoints (food search, recipe search, and any other collection expected to grow, per the NFR performance requirement) support pagination. Cursor- or offset-based pagination is acceptable; the choice is fixed per-resource in that resource's own module spec, but every list endpoint must declare one explicitly rather than returning an unbounded result set.

---

## 9. Effective Target Endpoint Shape

Endpoints that expose the resolved nutrition target for a profile return the `EffectiveTargetResolver` output shape defined in `29_Data_Model.md` §4.1: per-field `value`, `source`, `source_reference`, plus `resolver_version` and `resolved_at` at the response level. This is computed fresh per request; it is not read from a continuously synced table.

A separate, explicit action creates an `EffectiveTargetSnapshot` (per `29_Data_Model.md` §4.2) when a caller needs to anchor a resolved target to an auditable event (a consumed meal, a finalized daily summary, a coach recommendation). Creating a snapshot never mutates or replaces a prior snapshot.

---

## 10. Observability and Safety

- Endpoints log structured, correlation-id-tagged events for request/job tracing, without logging full health records, child data, raw images, full imported captions/transcripts, tokens, or secrets (Master §31).
- AI-provider calls happen server-side only; no endpoint accepts or forwards an AI provider API key from the client (Master §3.7, §30).

---

## 11. Out of Scope for Phase 1

- Concrete endpoint-by-endpoint contracts for individual modules (food logging, recipe library, analytics, coaching, etc.) — those are defined in their respective phase documents and must conform to the conventions above.
- GraphQL, in any form.
- Actual route implementation, middleware code, or generated OpenAPI/schema artifacts — this document defines the contract rules those artifacts must satisfy, not the artifacts themselves.

---

## 12. Layer 4A Foundation (implemented)

Layer 4A (`api/`, TypeScript/Express) implements the reusable foundation this document leaves open. Feature endpoints (food logging, recipes, meal planning, imports, wearables, etc.) still conform to everything above; this section fixes the concrete shapes that were previously "cursor- or offset-based, chosen per-resource" or "a typed wrapper if required."

**Error envelope (§6):**
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "requestId": "...", "details": { } } }
```
`details` is present only for errors that have safe, structured extra information (e.g. `VALIDATION_ERROR`'s field-level issues). Fixed codes for Phase 1 (`api/src/lib/errors.ts`): `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500).

**Non-disclosing authorization failure vs. FORBIDDEN (§4, §6, refined in Layer 4B):** a `profile_id` that does not exist and a `profile_id` the caller has *no access scope to at all* return the identical `404 NOT_FOUND` response — never a `403` (which would confirm the profile's existence to an Account with no relationship to it) and never a silent fallback. Once a caller has *some* access scope to a profile (e.g. `view_only`), that profile's existence is no longer secret from them, so an operation their scope doesn't cover (e.g. a `view_only` caller attempting a write) returns `403 FORBIDDEN` instead — this is more informative and correct than another 404 once existence is already known to the caller. Every Layer 4B route applies this via one shared helper (`api/src/lib/authorize.ts`), so the 404-vs-403 boundary is decided in exactly one place, not per route.

**Pagination (§8):** cursor-based, fixed as the one convention for every future list endpoint. Query parameters `cursor` (opaque, caller must not decode/construct it) and `limit` (default 20, max 100). Response wrapper: `{ "data": [...], "pagination": { "nextCursor": string | null, "limit": number } }` (the "typed wrapper" §6 anticipates).

**Idempotency (§7):** an `Idempotency-Key` request header, scoped per `(Account, route, key)`. Reusing a key with a different request body is a `409 CONFLICT`. This is transport-level retry-safety (never double-apply one HTTP write), distinct from `ImportJob`'s own domain-level idempotency keyed on `idempotency_key`/`canonical_url`/`content_fingerprint` (§7 above) — a future import endpoint may use both for different reasons. No endpoint requires this header yet; import endpoints are the first expected consumer and are not implemented in Layer 4A.

**Authentication (§4):** Supabase Auth access tokens are verified locally (HS256, the project's JWT secret) by API middleware, deriving the caller's Account only from the token's verified `sub` claim — never from any client-supplied value. This is one layer of the defense-in-depth chain fixed by Layer 4A: **Supabase authentication → API Account/Profile authorization → PostgreSQL RLS**. The API's authorization check is never treated as a substitute for RLS: every database read/write for a profile-scoped request still runs with the caller's own forwarded token (via Supabase's PostgREST/RPC endpoints, `@supabase/supabase-js`), never a service-role credential, so RLS is enforced independently of, and in addition to, the API-layer check.

**Guardian scope context (§4, `33_Security_and_Privacy.md` §2):** authorization resolves to one of `full_management` / `view_only` / `pediatric_weight_management` (the same value `profile_access_scope()` returns — the API never re-derives this independently of the database function that RLS itself uses), not a flattened boolean. Feature endpoints added later read this scope to decide permitted operations.

**Safe projections (§10, `33_Security_and_Privacy.md` §9.3/§9.4):** a `pediatric_weight_management` caller's Profile response omits `account_id`, `created_at`, and `deleted_at`, returning only `id`, `display_name`, `is_child`, `date_of_birth`, `access_scope`. Direct-owner/`full_management`/`view_only` callers receive the standard projection (adds `account_id`, `created_at`). No endpoint returns a raw database row.

**Implemented endpoints (feature APIs remain out of scope — see §11):**
- `GET /health` — unauthenticated liveness check.
- `GET /v1/profiles` — every Profile visible to the authenticated Account (owned, plus child profiles via an active `GuardianAuthorization`), paginated per the convention above.
- `GET /v1/profiles/{profile_id}` — a single Profile, safely projected per its resolved access scope.

---

## 13. Layer 4B — Profile Mutation, Goal, Target, and Measurement APIs (implemented)

Builds on §12's foundation. Every endpoint below uses the same authentication → API authorization → RLS chain, the same error envelope, and the same cursor pagination convention; nothing here introduces a second mechanism for any of those. Authorization matrices (which `full_management` / `view_only` / `pediatric_weight_management` may do what) are **not redecided here** — every allowed-scope list is transcribed verbatim from the already-approved RLS policies (`supabase/migrations/20260825121300_rls_targets_and_goals.sql`, `20260825121900_rls_pediatric_weight_management.sql`) and `33_Security_and_Privacy.md` §9's access matrix; the API never broadens what RLS already decided.

**`PATCH /v1/profiles/{profile_id}`** — `full_management` only. Body: `{ display_name?, date_of_birth? }`. `account_id`, `is_child`, `created_at`, and `deleted_at` cannot be set through this endpoint — the schema does not accept them, and `20260825130000_profile_immutable_columns.sql` freezes them at the database layer too (defense in depth), closing the same class of column-mutability gap already closed twice in Layer 3 (`auth_identity`, `guardian_authorization`).

**Goal** (`full_management`/`view_only`/`pediatric_weight_management` read; `full_management`/`pediatric_weight_management` write — `view_only` is read-only):
- `GET /v1/profiles/{profile_id}/goals`, `GET .../goals/{goal_id}`
- `POST /v1/profiles/{profile_id}/goals` — `goal_type` fixed enum (`weight_loss | maintenance | weight_gain | micronutrient_improvement | fiber_improvement | other`), `target_weight_kg?`, `target_date?` (future date), `notes?`, `is_active?`.
- `PATCH .../goals/{goal_id}` — partial update of the same fields, including `is_active` as the deactivation path.
- No `DELETE`: RLS still permits `full_management` to hard-delete (unchanged, Layer 2), but the API deliberately does not expose it — `is_active` is the intended way to retire a Goal while preserving history.
- **Known specification gap, not resolved by this layer:** `29_Data_Model_Data_Dictionary.md` §7 notes `goal_type` is "restricted to safe subset per Master §10.3" for pediatric profiles, but Master §10.3 states only qualitative product principles ("avoid adult-style aggressive weight-loss logic"), not a concrete list of which `goal_type` values are safe for a child. Layer 4B does not invent that list — doing so would be inventing a child-safety rule outside any approved specification. All six enum values remain selectable for a child profile via `pediatric_weight_management`/`full_management`, exactly as RLS already permits. This should be resolved by an approved specification before pediatric goal-setting is exposed in a mobile client.

**NutritionTarget** (field-level rows, not a wide object; read: all three scopes; write/"replace": `full_management`/`pediatric_weight_management`; `view_only` cannot write; no scope can `UPDATE` — see below):
- `GET /v1/profiles/{profile_id}/nutrition-targets` — current active value per field only.
- `GET .../nutrition-targets/history?field_name=` — full history (active + superseded), optionally filtered to one field.
- `POST /v1/profiles/{profile_id}/nutrition-targets` — `{ field_name, value, unit }`. "Replacing" a field is always a new row; the existing `trg_nutrition_target_supersede` trigger deactivates the prior active row for that `(profile_id, field_name)` atomically, together with `uq_nutrition_target_active_field`, so a duplicate-active state can never exist even transiently. No `PATCH`/`PUT` exists for an individual row — this is enforced by the RLS layer having no `UPDATE` grant at all, not merely by the API omitting a route.
- `field_name` has no fixed vocabulary in Phase 1 (Data Dictionary §8) — validated as a safe lowercase snake_case identifier shape, not against a closed enum. Per-field canonical units and plausible ranges are Phase 2 vocabulary concerns; only generic validation (finite, positive, bounded) is applied now.

**ClinicianTarget** (read: all three scopes; write: `full_management` ONLY — `pediatric_weight_management` cannot create a row here, matching RLS's deliberate omission of an insert policy for this scope):
- `GET /v1/profiles/{profile_id}/clinician-targets`, `GET .../clinician-targets/history?field_name=`.
- `POST /v1/profiles/{profile_id}/clinician-targets` — `{ field_name, value, unit }` only. `verification_status`, `source_type`, `provided_by_account_id`, and `entered_at` are never read from the request body — all four are computed server-side (`verification_status` is always `unverified`; `source_type` is derived from whether the target profile is a child; `provided_by_account_id` is the caller; `entered_at` is the server clock). **Creating a `platform_verified` row is not implemented** — it requires a separate, not-yet-approved verified-clinician-integration workflow; this is reported as deferred, not invented.

**WeightMeasurement** (immutable historical data; read: all three scopes; write: `full_management`/`pediatric_weight_management` — `view_only` cannot record a measurement):
- `GET /v1/profiles/{profile_id}/weight-measurements`
- `POST /v1/profiles/{profile_id}/weight-measurements` — `{ measured_at, value_kg, corrects_measurement_id? }`. `source` is always forced to `user_entered` server-side (never read from the request) — a client can never claim `wearable_synced` or `clinician_entered` through this endpoint (Data Dictionary §10: `source` is system_computed). A correction is a new row referencing the measurement it corrects via `corrects_measurement_id` (validated to belong to the same profile); there is no `PATCH`/`DELETE` — the Layer 1 `prevent_update()` trigger blocks `UPDATE` unconditionally regardless of RLS or API code.

**`GET /v1/profiles/{profile_id}/effective-target`** — the `EffectiveTargetResolver` (29_Data_Model.md §4.1), computed fresh on every request, never persisted by default. Response: `{ profile_id, resolved: { <field_name>: { value, unit, source, source_reference } }, resolver_version, resolved_at, implemented_sources }`. `resolved` is keyed by field name (matching this document's own worked example under the original §8). **Phase 1 implements only 2 of Master §8.1's 4 precedence levels** — `clinician_target` (wins) and `user_target` (fallback); `safety_rule` and `profile_derived` require formulas that belong to the not-yet-built Nutrition Engine and are never fabricated. `implemented_sources` (`["clinician_target", "user_target"]`) makes this contractually explicit. A field with no active source under either implemented level is simply absent from `resolved` — there is no Phase 1 vocabulary of "all possible fields" to report it as an explicit gap against.

**`GET /v1/profiles/{profile_id}/effective-target-snapshots`** — list only, same three read scopes. **No `POST` endpoint**: `EffectiveTargetSnapshot` creation is kept internal (spec-required — every `snapshot_reason` value is tied to a feature, meal logging/daily summaries/AI coach/data export, that does not exist yet). The write path exists as an internal service method (`EffectiveTargetService.createSnapshotInternal`, `full_management` only, matching RLS) for a future layer that implements one of those features to call, and is exercised directly by tests to prove immutability now.

---

## 14. Phase 2 Layer 5A — Food & Conversion Foundation (implemented)

Builds on §12/§13: same authentication → API authorization → RLS chain, error envelope and cursor pagination. Food, FoodAlias, FoodServing, Nutrient and FoodNutrient are **global reference data**, not profile data (Master §13), so these routes take no `profile_id` and need no profile scope — but every route still requires an authenticated Account token, and every query runs with the caller's own token under the `authenticated` role's RLS (`20260825121200_rls_food_reference_data.sql`: SELECT only). **No endpoint writes food reference data**; population belongs to a trusted ingestion workflow that is not part of this layer. Schema additions: `20260927120000_food_conversion_foundation.sql`; search revised by `20260928120000_food_search_canonical_name.sql` (final alignment).

**Endpoints:**
- `GET /v1/foods?q=&locale=&cursor=&limit=` — food search (localized aliases first, `canonical_name` as fallback). `q` (1–100 chars after normalization) is NFKC-normalized, trimmed, whitespace-collapsed and lower-cased; `%`/`_` are literal characters. `locale` (BCP 47 `language[-Script][-REGION]`, default `en`) is canonicalized (`ar-ae` → `ar-AE`). Result items: `{ id, canonical_name, category, source, display_name | null, display_locale | null, match: { source: alias|canonical_name, text, locale | null, kind: exact|prefix|contains, alias_source | null, identity_confirmation_required } }`. No match is an empty page, not an error.
- `GET /v1/foods/{food_id}?locale=&region=` — `{ id, canonical_name, category, source, display_name | null, display_locale | null, locale, region, density: { g_per_ml, source } | null, aliases[], servings[], nutrients[] }`. `nutrients[]` returns **every** sourced value (`{ nutrient_id, nutrient_key, nutrient_unit, amount, basis_quantity, basis_unit, source }`); choosing among coexisting sources is a calculation concern (Layer 5B), not decided here.
- `POST /v1/foods/{food_id}/convert` — body `{ quantity, from: { unit } | { serving_id }, to: { unit } | { serving_id } }` (exactly one key per side). Computes; persists nothing; safe to retry.
- `GET /v1/nutrients?cursor=&limit=` — the nutrient vocabulary, ordered by `canonical_key`.
- `GET /v1/units` — the unit registry with exact factors. `POST /v1/units/convert` — body `{ quantity, from_unit, to_unit }`, food-independent.

**Locale behavior.** Lookup chain = BCP 47 truncation then the default `en` (`zh-Hant-TW` → `zh-Hant` → `zh` → `en`). Search matches aliases in **every** locale (a food is never hidden because its only alias is in another language). `canonical_name` is also searchable as a deterministic fallback, matched as stored and with `_` read as a space (`chickpeas cooked` finds `chickpeas_cooked`). Ranking: match tier (**any alias match before any canonical_name-only match**, both per food and across foods) → match kind (exact, prefix, contains) → alias locale (position in the chain, then same language/other region, then other) → validated before `ai_matched` → primary → shorter matched text → `canonical_name` → id. `display_name` is the food's best alias for the chain, independent of what matched; it is `null` when the food has no alias — `canonical_name` is an internal key and is never returned as a translated display label, even when it was the matched text. Ranking is implemented once, in `search_foods()` (SECURITY INVOKER, `authenticated` only).

**Region behavior.** `region` defaults to the locale's region subtag. Food detail lists servings for that region plus region-agnostic ones (region-specific first) and omits other regions' servings; any serving remains convertible by explicit `serving_id`.

**Conversion rules (deterministic, Master §5).** Two dimensions, one canonical base each: mass → `g`, volume → `ml`. Path: source → base (unit factor, or `serving.canonical_quantity`) → mass/volume crossing **only** via the food's stored `density_g_per_ml` → target (÷ unit factor or ÷ serving quantity). All factors are exact legal definitions (e.g. `lb` = 453.59237 g, `cup_us` = 236.5882365 ml, `cup_us_legal` = 240 ml); arithmetic is exact rational (BigInt), so there is no floating-point drift. Regionally ambiguous measures (`cup`, `tbsp`, `tsp`, `fl_oz`, `pint`, `quart`, `gallon`) are **not** defaulted to any system. Count measures (slice, piece) are FoodServings, not units.

**Precision.** Rounded once, at the end: 6 decimal places in the target unit, ROUND_HALF_UP; response carries `precision: { decimal_places: 6, rounding: "half_up" }`. A non-zero result that would round to 0 is returned as unresolved (`result_rounds_to_zero`), never as `0`. Display rounding (e.g. whole grams) is a presentation concern and is not applied here.

**Outcomes.** `200 { status: "converted", quantity, unit, serving_id, precision, steps[], provenance[], confirmation_required, conversion_version }` or `200 { status: "unresolved", reason, message, candidates?, conversion_version }` with `reason` ∈ `unknown_unit`, `ambiguous_unit` (with `candidates`), `incompatible_dimensions` (unit-only mass↔volume), `density_unavailable`, `serving_not_found` (including another food's serving), `invalid_reference_data`, `result_rounds_to_zero`. An unresolved conversion is a defined outcome (§6), not an HTTP error. Malformed requests are `400 VALIDATION_ERROR`; an unknown `food_id` is `404 NOT_FOUND`.

**Provenance.** `steps[]` lists every factor applied (exact decimal string, multiply/divide, reference id); `provenance[]` names each unit definition, FoodServing and density used with its `source`. `confirmation_required` is `true` and `authoritative` is `false` whenever any reference value used is `ai_matched` (Master §16 — an unvalidated match does not silently become authoritative). `conversion_version` (`conversion-5a.1`) identifies the rule set.

**Final architecture decisions (Layer 5A alignment — normative).** These supersede anything above that is less specific.
1. *Nutrient basis.* `FoodNutrient.basis_quantity`/`basis_unit` are approved. Every nutrition calculation must read each record's explicit basis; no code may assume a record is per 100 g.
2. *Density.* `food.density_g_per_ml`/`density_source` are approved. Mass ↔ volume conversion happens only when trusted food-specific density exists. 1 ml = 1 g is never assumed, globally or per food.
3. *Serving canonical unit.* FoodServing canonical quantities normalize to `g` or `ml`, so a named serving resolves to an authoritative mass **or** volume. This does not make every serving convertible between mass and volume; that still requires density (rule 2).
4. *Ambiguous household units.* Generic `cup`, `tbsp`, `tsp`, `fl_oz`, `pint`, `quart`, `gallon` never silently select a measurement system: they are unresolved (`ambiguous_unit` + `candidates`) unless an explicit system-specific unit (e.g. `cup_us`, `tbsp_metric`) or a region-specific FoodServing resolves the meaning. Explicit variants remain in the registry.
5. *Precision.* Exact internal arithmetic with one final rounding boundary; 6 decimal places is the conversion-API precision, **not** the mobile display precision. Nutrition calculation must not round intermediate results.
6. *Conversion endpoint.* `POST` is correct for deterministic conversion: it takes structured input even though it persists nothing.
7. *Locale search.* Localized aliases are the primary search surface; `canonical_name` is a searchable fallback that ranks below alias matches and is never exposed as a display label (see "Locale behavior").
8. *AI identity vs nutrition authority.* **Food identity matching** and **nutrition data authority** are separate. An `ai_matched` alias (or any AI-assisted Food match) may identify a canonical Food and is flagged `identity_confirmation_required`; it does **not** make any AI-generated calories, macronutrients, micronutrients, serving weights or density authoritative, and it never creates FoodNutrient/FoodServing/density data. Layer 5B may perform authoritative nutrition calculations only from approved reference values with acceptable provenance. If a Food is identified but trusted nutrient data for it is unavailable, the engine must report that limitation — never substitute an AI-generated estimate as trusted FoodNutrient data. Conversions using `ai_matched` serving weights or density return `authoritative: false`.
9. *FoodNutrient source selection.* Multiple sourced values are returned side by side and no source is chosen. Layer 5B must define a deterministic nutrient-source resolution policy **before** nutrition aggregation is implemented. The source classes (`trusted_database`, `manufacturer_label`, `user_entered`, `ai_matched`) must remain distinguishable.
10. *Serving localization.* **Deferred.** FoodServing has no `locale` column and is not being redesigned now; serving descriptions are returned as stored. Localizing serving descriptions is a recorded requirement for later localization work.
11. *Pagination.* The 1000-row in-memory search/list pagination is acceptable for the development foundation only. Before a production-scale food database is loaded, food search/list must move to database-pushed pagination and search (with appropriate indexing).
12. *Production food data.* No production nutrition database has been selected. No production food data is loaded; test fixtures are test-only. Source selection, licensing and ingestion are separate work.

**Known limitations.** No production food data is loaded — integration tests use clearly labeled fixtures (`api/tests/helpers/foodFixtures.ts`); an approved external source and ingestion workflow are still required. Substring search is a sequential scan over `food_alias` (no trigram index yet). `FoodServing` has no `locale` column, so serving descriptions are returned as stored. Localized nutrient display labels (`(nutrient_id, locale)` lookup) are not implemented. Nutrient scaling/aggregation and source resolution are Layer 5B (rule 9). Search does a full scan over `food_alias` and `food` (rule 11).

---

## 15. Phase 2 Layer 5B — Deterministic Nutrition Calculation Engine (implemented)

The **single authoritative nutrition calculator** (Master §5). Food logging, recipe nutrition, the daily tracker, meal planning, grocery/portion intelligence, analytics and the AI coach must call this engine (`api/src/domain/nutrition/nutrition.engine.ts`) and must not implement their own nutrition arithmetic. AI never calculates calories, macronutrients, fiber, micronutrients, serving scaling, unit conversion or aggregation; once a Food and quantity are resolved, values come only from here. No schema change was needed.

**Endpoint.** `POST /v1/nutrition/calculate` — authenticated; reads reference data under the caller's own RLS-scoped token; **persists nothing** (no MealLog, Recipe or snapshot) and cannot modify Food/Nutrient data; safe to retry.

Request: `{ items: [{ food_id, quantity, unit } | { food_id, quantity, serving_id }] }`, 1–50 items. `quantity` is a finite number `> 0` and `≤ 1,000,000`. `unit` must be an exact Layer 5A registry code (`g`, `kg`, `ml`, `cup_us`, …); unit synonyms (`grams`), natural-language amounts (`handful`) and regionally ambiguous measures (`cup`) are rejected — interpreting them belongs to a later input/AI layer.

Response (200):
```
{ calculation_version: "nutrition-calculation-5b.1", conversion_version: "conversion-5a.1",
  precision: { decimal_places: 6, rounding: "half_up" },
  items: [{ index, food_id, canonical_name, input: { quantity, unit, serving_id },
            normalized_quantity: { status: "converted", quantity, unit: g|ml, authoritative, steps[], provenance[] }
                               | { status: "unresolved", reason, message },
            resolved_nutrient_count,
            nutrients: [{ nutrient_id, nutrient_key, unit, status, value | null, is_zero, below_output_precision,
                          source: { food_nutrient_id, source, amount_per_basis, basis_quantity, basis_unit, quantity_in_basis_unit } | null,
                          candidates[], excluded[], conversion_reason | null }] }],
  aggregate: { item_count, coverage_summary: { complete, partial, unavailable },
               nutrients: [{ nutrient_id, nutrient_key, unit, coverage, value | null, is_zero, below_output_precision,
                             resolved_item_count, item_count, missing: [{ index, status }] }] } }
```
Every nutrient in the `Nutrient` vocabulary appears, per item and in the aggregate, so "unknown" is always explicit.

**Invalid input vs unresolved reference data.** Invalid input is `400 VALIDATION_ERROR` with the offending path (`items.N.food_id`, `items.N.serving_id`, …): malformed/zero/negative/non-finite/oversized quantity, unsupported unit, both or neither of `unit`/`serving_id`, unknown `food_id`, a `serving_id` that does not exist or belongs to another food. Legitimately insufficient reference data is **not** an error: it is a per-nutrient status in a 200 response.

**Pipeline** (per item): input → normalize the quantity to its own canonical base (`g`/`ml`) with the Layer 5A engine → for each nutrient, resolve the one authoritative FoodNutrient record → read **its** explicit `basis_quantity`/`basis_unit` (never assume per 100 g) → convert the input into `basis_unit` with the Layer 5A engine (mass ↔ volume only via stored trusted density) → `value = amount × quantity_in_basis_unit ÷ basis_quantity` → aggregate across items → round once at the output. The engine reuses Layer 5A's `convertExact` (the unrounded form of `convert`), so no conversion logic is duplicated and no converted quantity is rounded before scaling. Servings carry no nutrition of their own: `2 × (1 slice = 30 g)` → 60 g → scaled from the nutrient basis.

**Nutrient statuses.** `resolved` (value present; may be exactly 0), `no_data` (no FoodNutrient record), `not_authoritative` (only `ai_matched`/`user_entered` records), `ambiguous_nutrient_source`, `basis_unreconcilable` (e.g. volume input vs per-100 g basis without density; `conversion_reason` says why), `non_authoritative_quantity` (the only path to the basis uses an `ai_matched` serving weight or density), `quantity_unresolved`, and (Layer 6A, recipe aggregates only) `item_unresolved` — the item never reached the engine, e.g. an unmatched recipe ingredient (§17). Layer 7A meal aggregates may also list `partial_contribution` in `missing[]` (§18). Only `resolved` carries a value; every other status has `value: null`, never 0.

**Source-resolution policy** (one Food + one Nutrient → at most one record; `sourceResolution.ts`):
1. Only `trusted_database` and `manufacturer_label` values can be authoritative.
2. `ai_matched` values are never authoritative (§14 rule 8) — excluded and listed in `excluded[]` with `ai_matched_not_authoritative`.
3. `user_entered` values are excluded (`user_entered_not_permitted`) because Master §16 allows user-entered label data only within a product/user-data workflow that permits it, and none exists yet. They stay identifiable. (Since the Layer 5C final boundary, global `food_nutrient` rejects new `user_entered`/`ai_matched` rows; rules 2–3 remain as defense in depth for any retained historical row and for future non-global inputs.)
4. Exactly one authoritative candidate → selected, with its `food_nutrient_id`, source and basis in `source`.
5. Both `trusted_database` **and** `manufacturer_label` → `ambiguous_nutrient_source` with both `candidates`, even if the amounts agree. The principle "label data for the exact product, database data for a generic food" needs to know whether a Food row is a generic food or an exact branded product; the current schema cannot tell (`Food` is "food/product identity", `Product`/`Barcode` are not modeled, and `Food.source` is the identity row's provenance, not its kind). Resolving this needs the Product model (`11_Barcode_and_QR.md`).
Competing values are **never summed and never averaged**.

**AI identity vs nutrition authority.** A Food identified through an `ai_matched` alias is calculated like any other Food, but only from authoritative records. If none exist, every nutrient is `no_data`/`not_authoritative` with a null value — the engine reports the limitation and never estimates.

**Energy.** Energy is an ordinary nutrient: the stored authoritative energy value is scaled like any other. There is **no** energy derivation (no 4/4/9 or other factor formula); if no authoritative energy value is stored, energy is unavailable. Energy in different units (`kcal` vs `kJ`) is not interconverted (see unit normalization).

**Macros, fiber, micronutrients.** One arithmetic path for every nutrient; no per-nutrient special cases. Fiber is a normal nutrient; Fiber Intelligence must consume these values. The engine is keyed by `Nutrient.canonical_key` and does not hard-code which keys are "calories"/"protein"/"carbohydrate"/"fat" — no approved nutrient vocabulary exists yet (see limitations).

**Nutrient-unit normalization** (`nutrientUnits.ts`). Values are reported in the Nutrient's canonical unit (`Nutrient.unit`). Aggregation normalizes every contribution to that unit before adding. Compatible: `g`, `mg`, `mcg` (`µg`/`μg`/`ug` are spellings of `mcg`), exact SI factors. **Not** converted: `kcal` ↔ `kJ` (several factors are in use and none is approved), `IU` or any other unit ↔ anything but itself. A contribution in an incompatible unit is left out and reported in `missing[]` as `incompatible_unit`, never added. Because `FoodNutrient` stores amounts in `Nutrient.unit`, all stored values of one nutrient already share a unit today; the normalization guards the aggregation boundary.

**Completeness.** Per aggregate nutrient: `complete` = a resolved value for every item; `partial` = for some items (the `value` is the sum of the known contributions — a **lower bound, not a total**; `missing[]` lists each excluded item and why); `unavailable` = no item resolved, `value: null`. Clients must not display a partial value as a complete total.

**Known zero vs unknown.** A stored FoodNutrient amount of 0 is a known zero (`status: resolved`, `value: 0`, `is_zero: true`); the absence of a record is unknown (`no_data`, `value: null`). Known zeros aggregate as known values (all-zero ⇒ `complete`, `0`, `is_zero: true`). `below_output_precision: true` marks a non-zero value that rounds to 0, so it is never mistaken for a known zero.

**Precision.** All arithmetic is exact rational (BigInt) — quantities, conversion factors, densities, bases and sums — so there is no floating-point accumulation and no intermediate rounding (three items of exactly ⅓ g aggregate to exactly 1 g). Rounding happens once, at the API output: 6 decimal places, ROUND_HALF_UP. Per-item values and the aggregate are each rounded from their own exact values, so rounded per-item values may not sum to the rounded aggregate in the last decimal place; the aggregate is the authoritative total. 6 dp is the API precision, not the mobile display precision.

**Calculation version.** `nutrition-calculation-5b.1` (and the underlying `conversion-5a.1`) is on every response so a future persisted Recipe/Meal nutrition snapshot can record which deterministic rules produced it. Any change to these rules must bump the version.

**Provenance.** Per item: the Food, the input and its normalized quantity with every conversion step and the serving/density sources used; per nutrient: the selected `food_nutrient_id`, its source, `amount_per_basis`, basis and `quantity_in_basis_unit`, the excluded records and why, or the ambiguous candidates. The domain layer keeps the exact rational values; only rounded numbers leave the API.

**Security.** Authentication is required; reads use the caller's token under RLS (SELECT-only on the food tables); no service-role access; only `POST /v1/nutrition/calculate` exists on this route.

**Known limitations / deferred.**
- ~~No approved nutrient vocabulary~~ — **resolved by Layer 5C (§16)**. The engine stays key-agnostic.
- `trusted_database` vs `manufacturer_label` conflicts stay ambiguous until the Product model can tell generic foods from exact products.
- `user_entered` nutrient values are unusable until a product/user-data workflow permits them.
- ~~User-entered serving weights remain usable~~ — **superseded by Layer 5C (§16)**: user-entered servings/densities are personal data, rejected from the global tables and non-authoritative if encountered.
- Reference data is fetched per request (nutrient vocabulary capped at 1000 rows), per the §14 rule-11 development-foundation limits.

---

## 16. Phase 2 Layer 5C — Nutrient Vocabulary & Data Authority (implemented)

Architecture hardening on top of §15. **The nutrition engine is unchanged in its arithmetic and stays nutrient-key agnostic**: it never branches on protein, fiber, iron or any other key. The vocabulary is metadata for projections, analytics and ingestion. Layer 5B's `ambiguous_nutrient_source` behavior is approved as-is (competing usable records for one Food + Nutrient are never averaged, summed or arbitrarily ordered; the future Product/Barcode model supplies the missing context). Migration: `20260929120000_nutrient_vocabulary_and_authority.sql`. Code: `api/src/domain/nutrition/vocabulary.ts`, `nutritionSummary.ts`, `api/src/domain/authority/authority.ts`.

**Canonical nutrient vocabulary.** Stable, language-independent `Nutrient.canonical_key` values (translated labels belong to the `(nutrient_id, locale)` lookup, never new keys). Seeded by the migration as platform metadata (not food data); a test asserts the database rows equal the code registry.

| key | role | unit | canonical meaning (what a source value must mean to map here) |
|---|---|---|---|
| `energy` | energy | kcal | Food energy in kcal as stated by the source; never derived |
| `protein` | macronutrient | g | Total protein |
| `carbohydrate` | macronutrient | g | **Total carbohydrate, including dietary fiber and sugars** (US "Total Carbohydrate", USDA "by difference") * |
| `fat` | macronutrient | g | Total fat (total lipid) |
| `fiber` | fiber | g | Total dietary fiber |
| `sodium` | micronutrient | mg | Sodium (not salt) |
| `potassium`, `calcium`, `iron`, `magnesium`, `zinc` | micronutrient | mg | The element as stated |
| `vitamin_a` | micronutrient | mcg | mcg RAE * |
| `vitamin_c` | micronutrient | mg | Ascorbic acid |
| `vitamin_d` | micronutrient | mcg | D2 + D3 by mass; IU not mapped * |
| `vitamin_e` | micronutrient | mg | Alpha-tocopherol * |
| `vitamin_k` | micronutrient | mcg | By mass as stated |
| `thiamin`, `riboflavin`, `vitamin_b6` | micronutrient | mg | As stated |
| `niacin` | micronutrient | mg | As stated; preformed vs niacin equivalents recorded per source mapping * |
| `folate` | micronutrient | mcg | mcg DFE; food/total folate not mapped without an approved conversion * |
| `vitamin_b12` | micronutrient | mcg | As stated |

\* `measure_requires_mapping_review`: several distinct scientific measures share the name, so each source's measure must be confirmed when its ingestion mapping is written, never assumed.

**Roles.** `Nutrient.role` ∈ `energy | macronutrient | fiber | micronutrient | other` — explicit metadata, never inferred from display strings. `GET /v1/nutrients` returns `role` and accepts `?role=` to filter. Every nutrient in `POST /v1/nutrition/calculate` (per item and aggregate) and in `GET /v1/foods/{id}` carries `nutrient_role`.

**Reporting units.** One per nutrient (`Nutrient.unit`), enforced by `nutrient_role_reporting_unit`: energy → `kcal`; macronutrient and fiber → `g`; micronutrient → `mg` or `mcg`. `IU` and `kJ` are not permitted reporting units. There is exactly one energy identity (`uq_nutrient_single_energy`). IU ↔ mass conversions are not implemented; an IU-only source value stays unmapped.

**Energy semantics.** `energy` in kcal is the one canonical energy identity for application summaries. Stored authoritative energy values are the only source; missing energy is never derived from macronutrients (no 4/4/9). kJ may be accepted as source data only once an explicit kJ → kcal policy is approved; until then a kJ-only value is not mapped, and kcal and kJ are never combined (the engine refuses to add incompatible units).

**Carbohydrate semantics.** The platform `carbohydrate` is total carbohydrate including fiber. Datasets that distinguish "by difference", "available" and "total" must be mapped explicitly by ingestion; "available carbohydrate" (fiber excluded) must not be mapped to `carbohydrate` without an approved conversion. No fuzzy name matching. The platform does not compute net carbohydrate.

**Data authority model** (`authority.ts`; every provenance/source entry now carries `authority`):

| class | source | meaning |
|---|---|---|
| `global_reference` | `trusted_database` | approved trusted database value; authoritative for everyone |
| `exact_product` | `manufacturer_label` | authoritative for the exact represented product; competes ⇒ ambiguous until Product identity exists |
| `personal_user_confirmed` | `user_entered` | user-confirmed personal data; usable only for that user's own resolved food/meal within an approved personal/product workflow; never global reference, never authoritative for other users |
| `non_authoritative_inference` | `ai_matched` | AI match/estimate; may suggest, never authoritative |

**User-entered servings and density.** `food_serving` and `food` are global tables with no owner column, so a user-entered serving weight or density stored there would be read by — and reused for — every account. The database now rejects both (`food_serving_no_personal_source`, `food_density_no_personal_source`), and the engine treats any user-entered serving/density it encounters as non-authoritative (`authority: personal_user_confirmed`, conversion `authoritative: false`, nutrients `non_authoritative_quantity`). User-confirmed amounts reach the engine today as explicit quantities (e.g. "my bowl = 250 g" is sent as `250 g`). **Future need:** a profile-scoped serving/measurement mechanism (owned by a later Food Logging/personalization layer) to store "my bowl = 250 g" as personal data. It must never be auto-promoted into `food_serving`.

**AI-matched servings/density.** Remain non-authoritative (`non_authoritative_inference`). AI may suggest "about one cup" or "about 120 g"; a later user confirmation turns that into a user-confirmed input quantity for that user's meal — it never becomes global reference data.

**Nutrition summary projection.** `POST /v1/nutrition/calculate` now also returns `summary` (aggregate) and `items[].summary`:
```
summary: { energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g }
  each: { nutrient_key, value | null, is_zero, below_output_precision,
          coverage: complete|partial|unavailable,
          status: null | partial | no_data | <item nutrient status> | not_in_vocabulary | unit_mismatch,
          resolved_item_count, item_count }
```
A **projection** of the Layer 5B result (`nutritionSummary.ts`): it looks up each field's canonical key and copies the already-calculated value and coverage. It performs no arithmetic — no summing, scaling, derivation or unit conversion. Unavailable stays `null`, partial stays `partial` (a lower bound), a known zero stays `0` with `is_zero: true`. A field is bound to its key **and** unit (`energy_kcal` requires `energy` in kcal); otherwise it is `unavailable` with `unit_mismatch`/`not_in_vocabulary` rather than mislabeled. Stable shape for recipe cards, meal logs, the daily tracker, meal plans and progress screens.

**Micronutrients** stay in the generic `nutrients[]` result (same engine), found by stable key (`iron`, `calcium`, `vitamin_d`, …) or `nutrient_role: "micronutrient"`. No separate micronutrient engine.

**Production ingestion contract** (normative for any future dataset; nothing is ingested yet):
1. Every external nutrient identifier is mapped explicitly to a platform `canonical_key` (e.g. `<source> nutrient 1008 → energy`, `<source> nutrient 1003 → protein`). Display-name matching alone is never a mapping.
2. Each mapping records the source's measure/definition and unit and must match the canonical meaning above; a mismatch (kJ energy, IU vitamins, available carbohydrate, food folate, retinol) is left unmapped until an approved conversion exists. Mapping-review nutrients (*) need explicit sign-off.
3. Amounts are stored in the nutrient's reporting unit (converted only within g/mg/mcg); `basis_quantity`/`basis_unit` state the source's basis explicitly.
4. A nutrient the source does not report gets **no** row (unknown); a reported 0 gets a 0 row (known zero).
5. Mappings are versioned and provenanced (source dataset + release, mapping version, reviewer), so every FoodNutrient value can be traced to its source identifier.
6. Ingested rows use `trusted_database` or `manufacturer_label` only; the global tables never receive `user_entered` servings/density or `user_entered`/`ai_matched` nutrient values.

**Global nutrient data boundary (Layer 5C final).** `food_nutrient` is **global/reference nutrition data**. Migration `20260930120000_food_nutrient_global_source_boundary.sql` adds `food_nutrient_global_source`: new or updated rows must be `trusted_database` (trusted ingestion/admin workflows) or `manufacturer_label` (representable; exact-product resolution deferred to Product/Barcode). **Personal user-entered nutrition is not stored in `food_nutrient`** — it will belong to an approved profile/product-specific workflow and storage model (not designed yet). **AI estimates are not stored in `food_nutrient` as global nutrition truth.** The constraint is added `NOT VALID` so historical rows are never silently deleted: any pre-existing `user_entered`/`ai_matched` row is reported by the migration (`NOTICE`), kept for explicit review, still excluded by the engine, and cannot be updated in place; `alter table food_nutrient validate constraint food_nutrient_global_source` once reviewed. Authenticated clients have no write access to the table in any case (RLS, SELECT-only). The engine's exclusion of `ai_matched`/`user_entered` records is tested with in-memory records (unit tests); the integration fixtures contain only permitted sources.

---

## 17. Phase 2 Layer 6A — Recipe Book Core & Deterministic Recipe Nutrition (implemented)

Builds on §12–§16: same authentication → API authorization → RLS chain, error envelope and cursor pagination. Uses the existing Layer 1 entities `Recipe`, `RecipeVersion`, `RecipeIngredient`, `RecipeInstruction`, `RecipePersonalizedVariant` — no second recipe system. `09_Recipe_Intelligence.md` and `10_Recipe_Library.md` are **not available in the repository**; only the deterministic core below is implemented, and everything those documents own (discovery, sharing, deletion semantics, categories/tags/ratings, favorites, import, AI) is deferred rather than invented. Migration: `20261001120000_recipe_book_core.sql`. Code: `api/src/domain/recipes/`.

**Endpoints** (all under `/v1/profiles/{profile_id}`):

| Method & path | Scopes | Purpose |
|---|---|---|
| `GET /recipes?q=&cursor=&limit=` | read | The Profile's recipes (authored under it), most recently updated first; `q` = case-insensitive title contains (NFKC, trimmed, whitespace-collapsed, 1–100 chars) |
| `POST /recipes` | write | Create Recipe + version 1 (201, detail DTO) |
| `GET /recipes/{recipe_id}` | read | Detail: current version, ingredients, instructions, nutrition |
| `PATCH /recipes/{recipe_id}` | write | Create a **new** RecipeVersion (200, detail DTO) |
| `GET /recipes/{recipe_id}/nutrition` | read | Current version's nutrition, with per-ingredient breakdown |
| `GET /recipes/{recipe_id}/versions?cursor=&limit=` | read | Version history, newest first, `is_current` flagged |
| `GET /recipes/{recipe_id}/versions/{version_id}` | read | One historical version with its own content and nutrition |
| `GET /recipes/{recipe_id}/versions/{version_id}/nutrition` | read | That version's nutrition, with breakdown |
| `GET /recipe-variants?base_recipe_id=&cursor=&limit=`, `GET /recipe-variants/{variant_id}` | read | Personalized variants of this Profile (read only) |

**Authorization** — transcribed from `20260825121500_rls_recipes.sql` / `can_read_recipe` / `can_manage_recipe`, never broadened: *read* = any scope on the authoring Profile (`full_management`, `view_only`, `pediatric_weight_management` — the latter per `20260825121900`); *write* = `full_management` only (a direct adult owner resolves to `full_management`). No scope → `404` (non-disclosing); a scope that does not cover the operation → `403`. A revoked guardian has no scope. Every route filters on `created_by_profile_id = profile_id` in addition to RLS, so a recipe is never reachable through another Profile's path; `shared_library` recipes authored elsewhere are not listed (no public/community discovery). New recipes are always `private`; `visibility` is not settable in this layer.

**Create** — body `{ title, description?, servings, ingredients: [...] (1–100), instructions?: [text] (0–100) }`. Array order is authoritative: ingredient `sort_order` and instruction `step_number` are assigned 1..n; clients cannot send order numbers, `match_status`, `match_confidence`, `visibility` or version numbers (undeclared fields are stripped).

**Ingredient representation** — `{ text, food_id?, serving_id?, quantity?, unit? }`, stored in `RecipeIngredient`:
- `text` → `raw_ingredient_text` (the line as written, immutable provenance).
- `food_id` → the canonical Food the user selected; stored as `match_status: matched` (a user-confirmed match, `match_confidence: null`). Omitted → the ingredient is kept as text only, `match_status: unmatched`, `food_id: null` — never force-matched to a Food.
- Amount: `quantity + unit` (an exact Layer 5A registry code — `g`, `kg`, `ml`, `cup_us`, …; synonyms and ambiguous `cup`/`tbsp` are rejected, as in §15) **or** `quantity + serving_id` (a FoodServing that must belong to `food_id`; new column `food_serving_id`) **or** `quantity` alone (a count such as "2 eggs") **or** nothing ("salt to taste"). `unit` and `serving_id` are exclusive; either requires `quantity`. `quantity` is finite, `> 0`, `≤ 1,000,000`.
- The quantity is **recipe-specific input**: it never creates or changes a `FoodServing`, `Food` or `FoodNutrient` (Layer 5C authority). No calculated nutrient value is stored on a RecipeIngredient.
- Invalid references are `400` with the path: unknown `food_id` (`ingredients.N.food_id`), a serving that does not exist or belongs to another food (`ingredients.N.serving_id`). The database enforces the same (`fk_recipe_ingredient_food_serving`, `recipe_ingredient_serving_requires_food`, `recipe_ingredient_unit_xor_serving`, `recipe_ingredient_amount_requires_quantity`).

**Yield / servings** — `RecipeVersion.servings`, a positive serving count (fractional allowed, max 1000); zero, negative, NaN, Infinity and non-numbers are `400`. Required on create. A version with no yield (possible only for future imported data) reports `per_serving: null`, `per_serving_status: "servings_not_defined"`; per-serving is never computed by assuming one serving.

**Versioning** — `RecipeVersion`, `RecipeIngredient`, `RecipeInstruction` are immutable (no client UPDATE/DELETE grant; Layer 1 `prevent_update` triggers block UPDATE for everyone). `PATCH` never edits a version: fields omitted from the body are carried over from the current version (`ingredients`/`instructions`, when present, replace the whole list; carried-over ingredients keep their stored match state), then `create_recipe_version()` writes version n+1 with new ingredient/instruction rows and moves `Recipe.current_version_id` (and `canonical_title`) **in one transaction**. The function is `SECURITY INVOKER` — each statement runs under the caller's existing RLS policies; it adds atomicity and serialized version numbering (`SELECT … FOR UPDATE` on the recipe), not privileges. `Recipe.current_version_id` must reference a version of the same recipe (`trg_recipe_current_version_belongs`). Concurrency: an edit is always based on the version it read; if another version became current in between (or `expected_current_version_id` is stale) the write is refused with `409 CONFLICT` and nothing is created.

**Recipe nutrition** — computed on read through the Layer 5B engine, never by recipe-specific arithmetic and never by AI (`recipe.nutrition.ts`):
```
RecipeVersion → its RecipeIngredients (sort_order)
  → confirmed Food + quantity + unit | FoodServing
  → Layer 5A normalization → Layer 5B source resolution & scaling (calculateItem)
  → aggregateNutrients                        = whole_recipe
  → divideAggregate(servings)                 = per_serving (exact rational division)
  → Layer 5C projectAggregateSummary          = summary for each
```
Response (`/nutrition`; the detail DTO embeds the same object without `ingredients`):
```
{ recipe_id, recipe_version_id, version_number, is_current,
  calculation_version, conversion_version, precision, servings,
  ingredient_count, calculated_ingredient_count,
  whole_recipe: { summary: { energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g },
                  item_count, coverage_summary, nutrients: [ …§15 aggregate entries… ] },
  per_serving:  { servings, summary, item_count, coverage_summary, nutrients } | null,
  per_serving_status: available | servings_not_defined,
  ingredients: [{ ingredient_id, index, nutrition_status, calculation: <§15 item> | null }] }
```
`missing[].index` / `ingredients[].index` is the ingredient's 0-based position.

**Completeness** — §15 semantics per nutrient, whole recipe and per serving alike: `complete` (every ingredient resolved), `partial` (some; the value is a **lower bound**), `unavailable` (none; `value: null`). A known zero stays `0`/`is_zero: true`; unknown is never 0. Per-serving keeps the whole-recipe coverage (dividing never makes a partial total complete). **An ingredient that cannot be calculated is never dropped**: it enters the aggregate with every nutrient `item_unresolved` (a new engine status for items that never reached the engine), so it keeps the totals partial/unavailable. Its `nutrition_status` says why: `food_unmatched`, `food_needs_confirmation` (a proposed but unconfirmed match — never counted, Master §18), `food_unavailable`, `quantity_missing`, `unit_missing`. A calculated ingredient can still have individual nutrients unresolved for §15 reasons (`no_data`, `ambiguous_nutrient_source`, `basis_unreconcilable`, …).

**Summary & micronutrients** — the five summary fields for both whole recipe and per serving are the Layer 5C projection of those aggregates (no separate calculation; no 4/4/9 energy). Micronutrients are in the same generic `nutrients[]` (key + `nutrient_role`); per-serving micronutrients are the same exact division of the whole-recipe value. No second engine.

**Authority** — recipe nutrition uses only what §15/§16 already permit (authoritative FoodNutrient records; `ai_matched` serving/density paths are `non_authoritative_quantity`). Creating or editing a recipe writes only recipe rows; it never writes Food, FoodServing, FoodNutrient or density data.

**Historical reproducibility** — every version keeps its own immutable title, yield, ingredients (Food, quantity, unit/serving, order) and instructions; its nutrition is always calculated from **that** version's ingredients and yield, so editing a recipe never changes what an older version reports. Nutrition is not persisted: it is recomputed with the current reference data and rule set (`calculation_version`/`conversion_version` are returned). If global reference values are corrected later, a recomputed historical version reflects the correction; a frozen per-meal nutrition snapshot belongs to Meal Logging.

**Future compatibility (not built).** *Meal planning:* a future PlannedMeal can reference an exact `Recipe` + `RecipeVersion` (+ `RecipePersonalizedVariant`) and a serving count; version ids are stable and version content immutable (`MealItem` already references `recipe_version_id`/`recipe_personalized_variant_id`). *Grocery:* each ingredient keeps its structured identity (`food_id`), `quantity`, `unit` or `serving_id`, order and original text, with the version's yield and the source recipe/version, so shopping requirements can later be derived without re-parsing text or reading nutrition totals.

**Personalized variants** — read only. A variant references its base Recipe and base RecipeVersion, belongs to one Profile (read: `full_management`, `view_only`, `pediatric_weight_management` per RLS), and never overwrites the base. `adjustments_payload` is returned as stored; its structure is not specified (Data Dictionary §23), so creating/editing variants and variant nutrition are **deferred**.

**Deferred** — `DELETE`/archive (Data Dictionary §19 defers shared-library deletion implications to `10_Recipe_Library.md`; RLS still permits a manager to delete, but no endpoint exposes it); visibility changes and shared-library/community discovery; RecipeCategory/RecipeTag/RecipeRating (Data Dictionary §34) and favorites (no approved entity); ingredient preparation/notes fields (none in the schema — kept in `text`); variant mutation and nutrition; nutrition snapshots; URL/social import, AI extraction/matching, OCR, barcode/product.

---

## 18. Phase 2 Layer 7A — Food & Meal Logging Core (implemented)

Records what a Profile **actually consumed**, using the existing `MealLog`/`MealItem` model (no second meal system, no planning entities). Every consumed item carries an immutable **nutrition snapshot** recorded at logging time, so history never changes when reference data or recipes change. Same authentication → API authorization → RLS chain, error envelope and cursor pagination as §12–§17. Migration: `20261002120000_meal_logging_core.sql`. Code: `api/src/domain/meals/`.

**Actual consumption vs planning.** Logging writes items directly as `consumed` (the server calculates the snapshot first); it does not walk `draft → planned → confirmed → consumed`, which remains the lifecycle for the future Meal Planning workflow. No planned/confirmed state is used here, and no MealPlan/PlannedMeal entity exists.

**Endpoints** (all under `/v1/profiles/{profile_id}/meals`):

| Method & path | Scopes | Purpose |
|---|---|---|
| `GET /?from=&to=&cursor=&limit=` | read | Meal history, newest local day first; `from`/`to` filter `logged_date` (inclusive) |
| `POST /` | write | Create a MealLog, optionally with its first items, **atomically** (201) |
| `GET /{meal_log_id}` | read | Meal detail: every item (active and superseded) + meal nutrition summary |
| `GET /{meal_log_id}/nutrition` | read | Meal aggregate with all nutrients, plus each item's summary |
| `POST /{meal_log_id}/items` | write | Add consumed items atomically (201, meal detail) |
| `GET /{meal_log_id}/items/{meal_item_id}` | read | One item with its full recorded nutrients and provenance |
| `POST /{meal_log_id}/items/{meal_item_id}/correct` | write | Atomic correction (201, the new item) |

No `PATCH`/`PUT`/`DELETE` of items, no void/remove, no planning endpoints.

**Authorization** — transcribed from `20260825121600_rls_meals.sql` and `20260825121900_rls_pediatric_weight_management.sql`, never broadened: *read* = `full_management`, `view_only`, `pediatric_weight_management`; *write* (log, add, correct) = `full_management`, `pediatric_weight_management` (the approved matrix grants pediatric scope nutrition logging; this layer is logging only — no targets, deficits, advice or AI). `view_only` → `403` on writes; no scope / revoked guardian → `404`. Routes filter on `(meal_log_id, profile_id)` in addition to RLS.

**Create / add request.**
```
POST /meals  { meal_type: breakfast|lunch|dinner|snack|other, logged_date: "YYYY-MM-DD",
               local_timezone: "Asia/Dubai", notes?, consumed_at?, items?: [item] (0–50) }
POST /meals/{id}/items  { consumed_at?, items: [item] (1–50) }
item = { type: "food",   food_id, quantity, unit | serving_id, consumed_at? }
     | { type: "recipe", recipe_id, recipe_version_id, servings, consumed_at? }
```
A request-level `consumed_at` is the default for items without their own. Any invalid item rejects the whole request (`400`, every issue with its path) and nothing is written.

**MealItem Food/Recipe invariant** (database-enforced): an item is a **Food item** (`food_id`, no `recipe_version_id`) or a **Recipe item** (`recipe_version_id`, no `food_id`/`food_serving_id`/`unit`) — never both, and a consumed item never neither (`meal_item_single_source`, `meal_item_consumed_has_source`, `meal_item_recipe_amount`).

**Quantity/unit semantics.** Food item: `quantity` + `unit` (an exact Layer 5A registry code; synonyms and ambiguous `cup`/`tbsp` rejected, as in §15) **or** `quantity` × a `FoodServing` that must belong to that Food (composite FK `fk_meal_item_food_serving_food`); exactly one (`meal_item_unit_xor_serving`, `meal_item_consumed_food_amount`). Recipe item: `quantity` = servings of that RecipeVersion's yield (fractional allowed, `> 0`, ≤ 100); a version without a yield cannot be logged. Quantities are finite and positive (NaN/Infinity rejected). An explicit amount such as "125 g chicken" is MealItem transaction data: it **never** creates or changes a global FoodServing, and logging never writes Food, FoodServing, FoodNutrient or density data.

**Same-Profile Recipe rule.** A recipe item may reference only an exact RecipeVersion of a Recipe authored by the **same Profile** (`recipe_id` + `recipe_version_id` must match: `400` otherwise); enforced in the database too (`meal_item_recipe_same_profile`). Shared/community consumption is future work. The exact `recipe_version_id` is stored permanently; history never resolves to `Recipe.current_version_id`.

**Historical nutrition snapshot.** `MealItem.nutrition_snapshot` (jsonb), `nutrition_calculation_version`, `nutrition_calculated_at` — required on every consumed item (`meal_item_consumed_snapshot`) and immutable. Contents (`snapshot_version: meal-item-snapshot-7a.1`):
- `source`: Food (`food_id`, `canonical_name`, `quantity`, `unit`, serving id/description/canonical quantity/source) or Recipe (`recipe_id`, `recipe_version_id`, `version_number`, title, yield, `servings_consumed`);
- `nutrients[]`: per nutrient — id, key, role, unit, `coverage` (complete/partial/unavailable), status, and the **exact** value as a fraction string (`"93/2"`), null when unknown;
- `provenance`: the Layer 5B item result (normalized quantity, conversion steps, serving/density sources, selected FoodNutrient records with source/authority/basis, excluded/ambiguous candidates) for a Food, or the Layer 6A recipe nutrition (whole, per serving, per-ingredient breakdown) for a Recipe;
- `calculation_version` (`nutrition-calculation-5b.1`), `conversion_version` (`conversion-5a.1`).

Food item values = the §15 engine result; Recipe item values = Layer 6A per-serving × servings (engine `multiplyAggregate`), keeping the recipe's own completeness (a nutrient partial across the recipe's ingredients stays partial). Later changes to Food, FoodServing, FoodNutrient, density, recipes or `Recipe.current_version_id` do not touch a recorded snapshot; a new item logged afterwards uses the current reference data.

**Meal nutrition aggregation.** Computed from the **active** items' snapshots only — `status = consumed` and not superseded — never recalculated from reference data. It uses the Layer 5B engine's `aggregateCoverage` (same nutrient-unit normalization, exact rational sums, completeness rules; incompatible units such as kcal/kJ are never added), one rounding at output (6 dp, half-up), and the Layer 5C summary projection (`energy_kcal`, `protein_g`, `carbohydrate_g`, `fat_g`, `fiber_g`). Coverage per nutrient: `complete` = every active item has a complete value; `unavailable` = none has a value (`null`, never 0); otherwise `partial` (a lower bound). An item that is itself partial (e.g. a recipe with an unknown ingredient) contributes its lower bound and is listed in `missing[]` as `partial_contribution`. Nutrient definitions come from the snapshots themselves, so history does not depend on the live vocabulary. Response: `{ basis: "recorded_snapshots", precision, active_item_ids, excluded_item_ids, summary, item_count, coverage_summary, nutrients[] }` (`missing[].index` is the position in `active_item_ids`).

**consumed_at vs created_at; local day.** `consumed_at` is when the food was eaten — supplied by the client (item or request level) as an ISO 8601 instant **with an offset or Z**, not more than 5 minutes in the future; `created_at` is when the record was written. `MealLog.local_timezone` is an **IANA identifier** (`Asia/Dubai`, `Europe/London`, `America/New_York`, `UTC`); offsets (`+04:00`) and abbreviations (`EST`) are rejected, in the API and the database (`meal_log_integrity`). `logged_date` is the Profile-local calendar date under `local_timezone`, and every consumed item's `consumed_at` must fall on it in that zone (API `400` on `items.N.consumed_at`; database `meal_item_consumed_local_day`). Once a meal holds consumed items, its `logged_date`/`local_timezone` cannot change. There is no Profile default timezone yet (future Preferences). A future Daily Tracker answers "what did this Profile eat on 2026-09-28 in their local day" with `logged_date` (indexed with `profile_id`).

**Correction transaction.** `POST …/items/{id}/correct` `{ correction_reason (1–500 chars, required), item }` → `correct_meal_item()` in one transaction: lock the original (it must be consumed and not yet superseded — else `409`), insert the new consumed item with its **own** snapshot, `corrects_meal_item_id` and `correction_reason`, set the original's `superseded_by_meal_item_id`, and write the AuditEvent; any failure persists nothing. The correction's `consumed_at` defaults to the original's. A correction can itself be corrected (a chain); an item can be superseded only once (`uq_meal_item_corrects`). Database guarantees: a correction must target a consumed, unsuperseded item of the same meal (`meal_item_correction_target`), must supersede it before commit (deferred `meal_item_correction_completed`), and the supersession UPDATE may change **only** `superseded_by_meal_item_id`, only to a correction of that item (redefined `enforce_meal_item_status_transition`). Both rows stay stored and independently queryable; meal totals count only the latest.

**Correction audit.** Written by the `AFTER UPDATE` trigger `trg_meal_item_correction_audit` (SECURITY DEFINER), which fires only on the one legitimate supersession and derives every field itself: `actor_account_id = auth.uid()`, `actor_type = user`, `event_type = meal_item_corrected`, `subject = meal_item/<original id>`, payload `{ original_meal_item_id, correction_meal_item_id, meal_log_id, profile_id }` — ids only, no quantities, nutrition, notes or reason text. Clients still have no SELECT/INSERT on `audit_event`; the trigger cannot be invoked directly, so actor, profile, event type, target and payload cannot be forged. AuditEvent remains append-only.

**Notes.** `MealLog.notes` — optional, trimmed, ≤ 2000 characters; Profile-scoped meal data, never nutrition input, not sent to AI.

**DTOs.** Item: `{ id, meal_log_id, source_type: food|recipe, food: { food_id, canonical_name } | null, recipe: { recipe_id, recipe_version_id, version_number, title } | null, amount: { quantity, unit, serving_id, serving_description } | { servings }, status, consumed_at, created_at, is_active, logged_by_actor_type, correction: { corrects_meal_item_id, superseded_by_meal_item_id, correction_reason }, nutrition: { basis: "recorded_snapshot", snapshot_version, calculation_version, conversion_version, calculated_at, summary, coverage_summary } }` — names and figures come from the snapshot, as recorded. Item detail adds `nutrition.nutrients[]` and `nutrition.provenance`. Account ids are not exposed; `status_changed_by_account_id` and the AuditEvent hold who logged/corrected.

**Future compatibility (not built).** A future PlannedMeal links to actual consumption by referencing the consumed MealItem(s) (and may reference the same exact `recipe_version_id`); planned and actual stay separate records. The Daily Tracker aggregates active consumed items' snapshots per `(profile_id, logged_date)` with the same `aggregateCoverage`.

**Trust boundary — application-authoritative snapshots.** Consumed nutrition snapshots are server-generated historical records. The supported write path is *client → `/v1` API → deterministic nutrition engine → user-scoped Supabase connection → RLS → MealItem snapshot*. Clients submit consumption facts (Food or exact RecipeVersion, quantity, unit/serving, `consumed_at`, meal context), never nutrition totals: no request schema on these endpoints declares `nutrition_snapshot`, `nutrition_calculation_version` or any nutrient value, so under the unknown-field policy (§12, `middleware/validate.ts`) such fields are stripped before the service runs, and the snapshot is always computed by the engine — for logging and for corrections alike (tested). **Known limitation:** the API writes with the caller's own user-scoped database identity, so an Account that already has write permission for a Profile can technically call Supabase directly (e.g. `log_meal_items()`) and store a correctly shaped but fabricated snapshot for that Profile. PostgreSQL cannot prove a snapshot came from the TypeScript engine, so the guarantee is **application-authoritative, not cryptographically attested**. The limitation is confined to Profiles the Account already manages; it does not permit cross-Profile or cross-Account access, RLS bypass, editing an existing consumed snapshot, breaking correction immutability or the correction chain, or modifying global Food/Nutrient reference data — all of which remain database-enforced. **Possible future hardening (recorded, not designed or approved):** server-signed consumed snapshots — e.g. an API-held signing key with key id/version, secret storage such as Supabase Vault, pgcrypto verification in the database, canonical payload serialization, key rotation and optional replay/nonce protection — subject to a separate architecture/security review.

**Deferred.** Void/remove of a consumed item (no approved semantics; no DELETE); Profile default timezone; logging `RecipePersonalizedVariant`s (column exists, not accepted); editing `meal_type`/`notes` after creation; database-pushed pagination (meal history uses the shared 1000-row in-memory convention).

---

## 19. Phase 2 Layer 7B — Daily Nutrition Tracker (implemented)

A **read model** answering "what did this Profile consume on this local calendar day, and how does it compare with the Profile's effective targets". It computes nothing authoritative, persists nothing and writes nothing (no MealLog, MealItem, EffectiveTargetSnapshot, Goal, target, Food, Recipe or AuditEvent row — tested). No schema change. Code: `api/src/domain/dailyTracker/`.

**Endpoint.** `GET /v1/profiles/{profile_id}/daily-tracker?date=YYYY-MM-DD&timezone=<IANA>` — both required. `date` is the Profile-local calendar day; `timezone` is the caller's IANA zone, used **only** to decide whether `date` is the current local day (there is no Profile default timezone and no server-local "today"). A `date` after the current local date in `timezone` is `400`. Read scopes: `full_management`, `view_only`, `pediatric_weight_management` (the existing meal and target read policies); no scope / revoked → `404`. GET only.

**Local-day semantics.** A day's meals are the MealLogs with `logged_date = date` (Layer 7A: `logged_date` is the local day under each MealLog's own `local_timezone`, and every consumed item's `consumed_at` falls on it). Meals are never grouped by UTC date: the same instant logged in Asia/Dubai and America/New_York lands on the respective local dates (tested). A day can contain meals logged in different zones (travel); each meal reports its `local_timezone`.

**Actual intake — snapshot-only.** MealLogs of the day → **active** consumed MealItems (`consumed`, not superseded; draft/planned/confirmed/skipped/cancelled and superseded originals never count) → their immutable Layer 7A `nutrition_snapshot`s → `aggregateSnapshots` (engine `aggregateCoverage`: nutrient-unit normalization, exact arithmetic, completeness) → one rounding at output → Layer 5C summary (`energy_kcal`, `protein_g`, `carbohydrate_g`, `fat_g`, `fiber_g`, each with value/null, coverage, status) plus every nutrient. Nothing is recalculated from Food, FoodServing, FoodNutrient, density or recipes: later reference-data changes or recipe edits leave a day unchanged (tested). A correction replaces its original in the totals (counted once). `actual.basis` is `recorded_snapshots`, or `no_consumption` for a day with no active items — then every nutrient is a **known zero** (`value: 0`, `is_zero: true`, `coverage: complete`), distinct from unknown data inside consumed items (which stays partial/unavailable, never 0). Viewing an empty day creates no rows.

**Target — current day only.** The single EffectiveTargetResolver (`EffectiveTargetService.resolve`, sources `clinician_target` > `user_target`; no derived/TDEE/pediatric/wearable targets) is called for the **current local day only**; `target.fields[]` carries `field_name`, `value`, `unit`, `source`, `source_reference` (the target row id — no account ids). **Historical days return `target.status` and `comparison.status` = `historical_target_unavailable`** with no fields and no comparison: EffectiveTargetSnapshot has no local-date key and nothing yet creates day-applicable snapshots, so the target that applied on a past day cannot be determined reliably, and comparing past consumption with today's target is refused rather than guessed (see `29_Data_Model.md` §4.5).

**Target-to-nutrient mapping** (explicit, never guessed). A resolved field is compared with a nutrient only if its `field_name` is a canonical nutrient key (Layer 5C: `protein`, `iron`, `vitamin_d`, …) and its unit converts exactly to that nutrient's reporting unit (g/mg/mcg; kcal only to kcal), or its `field_name` is a Layer 5C summary field (`energy_kcal`, `protein_g`, `carbohydrate_g`, `fat_g`, `fiber_g`) with exactly that field's unit. Anything else is listed in `comparison.unmapped_targets[]` with a reason: `unknown_field` (e.g. `calories`), `incompatible_unit` (e.g. carbohydrate in kcal, `energy_kcal` in kJ), `duplicate_target_for_nutrient` (e.g. both `fat` and `fat_g` — neither is compared), `invalid_value`. Target field names remain free-form at write time (§13); an approved target-field vocabulary is still outstanding.

**Comparison contract** (`comparison.nutrients[]`, one per mapped target; values in the nutrient's reporting unit; exact arithmetic, rounded at output; measurement only — no judgemental labels):

| actual coverage | relation | `comparison_status` | `remaining` | `remaining_at_most` | `over_target_by` | `over_target_by_at_least` |
|---|---|---|---|---|---|---|
| complete | A < T | `below_target` | T − A | null | 0 | null |
| complete | A = T | `at_target` | 0 | null | 0 | null |
| complete | A > T | `above_target` | 0 | null | A − T | null |
| partial (A is a lower bound) | A < T | `undetermined` | **null** | T − A | null | null |
| partial | A = T | `at_or_above_target` | 0 | null | null | null |
| partial | A > T | `above_target` | 0 | null | null | A − T |
| unavailable | — | `actual_unavailable` | null | null | null | null |

`remaining` is never negative and is exact only when actual intake is complete; a partial total yields at most an upper bound on what remains. Each entry also carries `actual` (value, coverage) and `target` (converted value, `field_name`, `source`, `source_reference`, original value/unit). Micronutrients follow the same contract; nutrients without a target appear only in `actual`.

**Response.**
```
{ profile_id, date, timezone, is_current_day, meal_count, active_item_count,
  actual: { basis: recorded_snapshots|no_consumption, precision, conversion_version, summary, item_count, coverage_summary, nutrients[] },
  target: { status: current|historical_target_unavailable, resolver_version, resolved_at, implemented_sources, fields[] },
  comparison: { status: available|historical_target_unavailable, nutrients[], unmapped_targets[] },
  meal_groups: [{ meal_type, meals: [{ id, meal_type, logged_date, local_timezone, notes, created_at,
                                       active_item_count, items: [active item DTOs, §18], nutrition: { summary, item_count, coverage_summary } }] }] }
```
`meal_groups` follow the order breakfast, lunch, dinner, snack, other and include only types present. Only active items appear; correction history stays on the Meal APIs (§18). No account ids, RLS scope, audit or security data is returned.

**Performance.** Per request: profile scope check, one `meal_log` query for the day, one `meal_item` query for all of that day's meals, the nutrient vocabulary, and (current day only) the resolver's two target queries — no per-item queries, no caching. The shared 1000-row safety bound applies to a day's meal logs and items (far above a real day); no pagination is needed for a single day and none is introduced.

**Deferred.** Historical target comparison (needs a day-applicable target snapshot policy — §4.5 of the Data Model); an approved target field vocabulary (`calories` etc.); a Profile default timezone / "today" convenience endpoint; day ranges and trends; planned-vs-actual, adherence and goal scoring; wearable-adjusted targets.
