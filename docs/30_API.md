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

**Nutrient statuses.** `resolved` (value present; may be exactly 0), `no_data` (no FoodNutrient record), `not_authoritative` (only `ai_matched`/`user_entered` records), `ambiguous_nutrient_source`, `basis_unreconcilable` (e.g. volume input vs per-100 g basis without density; `conversion_reason` says why), `non_authoritative_quantity` (the only path to the basis uses an `ai_matched` serving weight or density), `quantity_unresolved`. Only `resolved` carries a value; every other status has `value: null`, never 0.

**Source-resolution policy** (one Food + one Nutrient → at most one record; `sourceResolution.ts`):
1. Only `trusted_database` and `manufacturer_label` values can be authoritative.
2. `ai_matched` values are never authoritative (§14 rule 8) — excluded and listed in `excluded[]` with `ai_matched_not_authoritative`.
3. `user_entered` values are excluded (`user_entered_not_permitted`) because Master §16 allows user-entered label data only within a product/user-data workflow that permits it, and none exists yet. They stay identifiable.
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
- No approved nutrient vocabulary: which `canonical_key` is energy (and whether in kcal or kJ), whether carbohydrate is "by difference" or "by summation", etc. The engine is key-agnostic; a mobile "calories/macros" summary needs that vocabulary first.
- `trusted_database` vs `manufacturer_label` conflicts stay ambiguous until the Product model can tell generic foods from exact products.
- `user_entered` nutrient values are unusable until a product/user-data workflow permits them.
- User-entered **serving weights** remain usable (Layer 5A semantics); only `ai_matched` serving weights/densities are non-authoritative.
- Reference data is fetched per request (nutrient vocabulary capped at 1000 rows), per the §14 rule-11 development-foundation limits.
