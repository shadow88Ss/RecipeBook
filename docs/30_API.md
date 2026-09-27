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
`details` is present only for errors that have safe, structured extra information (e.g. `VALIDATION_ERROR`'s field-level issues). Fixed codes for Phase 1 (`api/src/lib/errors.ts`): `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403 — reserved; not currently returned by any Layer 4A endpoint, see below), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500).

**Non-disclosing authorization failure (§4, §6):** a `profile_id` that does not exist and a `profile_id` the caller is not authorized for return the identical `404 NOT_FOUND` response — never a `403` (which would confirm the profile's existence to an Account with no access to it) and never a silent fallback. This is why `FORBIDDEN` is reserved but unused by the Profile endpoints specifically; a future endpoint where confirming existence is not itself sensitive may use `403` instead, deliberately, per that endpoint's own module spec.

**Pagination (§8):** cursor-based, fixed as the one convention for every future list endpoint. Query parameters `cursor` (opaque, caller must not decode/construct it) and `limit` (default 20, max 100). Response wrapper: `{ "data": [...], "pagination": { "nextCursor": string | null, "limit": number } }` (the "typed wrapper" §6 anticipates).

**Idempotency (§7):** an `Idempotency-Key` request header, scoped per `(Account, route, key)`. Reusing a key with a different request body is a `409 CONFLICT`. This is transport-level retry-safety (never double-apply one HTTP write), distinct from `ImportJob`'s own domain-level idempotency keyed on `idempotency_key`/`canonical_url`/`content_fingerprint` (§7 above) — a future import endpoint may use both for different reasons. No endpoint requires this header yet; import endpoints are the first expected consumer and are not implemented in Layer 4A.

**Authentication (§4):** Supabase Auth access tokens are verified locally (HS256, the project's JWT secret) by API middleware, deriving the caller's Account only from the token's verified `sub` claim — never from any client-supplied value. This is one layer of the defense-in-depth chain fixed by Layer 4A: **Supabase authentication → API Account/Profile authorization → PostgreSQL RLS**. The API's authorization check is never treated as a substitute for RLS: every database read/write for a profile-scoped request still runs with the caller's own forwarded token (via Supabase's PostgREST/RPC endpoints, `@supabase/supabase-js`), never a service-role credential, so RLS is enforced independently of, and in addition to, the API-layer check.

**Guardian scope context (§4, `33_Security_and_Privacy.md` §2):** authorization resolves to one of `full_management` / `view_only` / `pediatric_weight_management` (the same value `profile_access_scope()` returns — the API never re-derives this independently of the database function that RLS itself uses), not a flattened boolean. Feature endpoints added later read this scope to decide permitted operations.

**Safe projections (§10, `33_Security_and_Privacy.md` §9.3/§9.4):** a `pediatric_weight_management` caller's Profile response omits `account_id`, `created_at`, and `deleted_at`, returning only `id`, `display_name`, `is_child`, `date_of_birth`, `access_scope`. Direct-owner/`full_management`/`view_only` callers receive the standard projection (adds `account_id`, `created_at`). No endpoint returns a raw database row.

**Implemented endpoints (feature APIs remain out of scope — see §11):**
- `GET /health` — unauthenticated liveness check.
- `GET /v1/profiles` — every Profile visible to the authenticated Account (owned, plus child profiles via an active `GuardianAuthorization`), paginated per the convention above.
- `GET /v1/profiles/{profile_id}` — a single Profile, safely projected per its resolved access scope.
