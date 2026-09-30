# 37_Authentication_and_Login.md
# Phase 1 — Authentication and Login

**Status:** Phase 1 specification — authentication/session model. No auth implementation exists yet.
**Authority:** Subordinate to `00_Master.md`. Where anything below appears to conflict with `00_Master.md`, the Master controls.
**Supersedes:** `ACCOUNT_RECOVERY.md`, `APPLE_SIGN_IN.md`, `AUTH_SECURITY_TESTS.md`, `AUTHENTICATION_ARCHITECTURE.md`, `DEVICE_TRUST.md`, `EMAIL_ACCOUNT_CREATION.md`, `FACE_ID_AND_BIOMETRICS.md`, `GOOGLE_SIGN_IN.md`, `LOGIN_AND_REGISTRATION.md`, `PASSWORD_SECURITY.md`, `PROFILE_LINKING.md`, `SESSION_MANAGEMENT.md` (retained under `docs/fragments/` as historical source material; `SESSION_MANAGEMENT.md`, `PASSWORD_SECURITY.md`, and `ACCOUNT_RECOVERY.md` are additionally updated in place to remove ambiguity about the token authority).

---

## 1. Governing Rule

**Supabase Auth is the sole credential, access-token, and refresh-token authority for this platform.** No module, fragment, or future implementation introduces a second password store, token issuer, or session mechanism. Where anything below could be read as describing custom-built credential handling, it is not — it describes behavior delivered through Supabase Auth's supported flows.

---

## 2. Identity Model

- Authentication identifies the **Account** — the authenticated security principal.
- `Account.id` **is always identical to the Supabase Auth `auth.users.id`** for that user — set once at provisioning (§11) and never remapped. There is no separate Account/auth-user mapping table and none is needed: `auth.uid()` (Supabase's JWT `sub` claim) *is* `account.id`. Every RLS policy and helper function resolves the calling Account directly this way (`auth.uid() = account.id`, or `= profile.account_id` / `= guardian_account_id` reached from it).
- An Account may have one or more permitted Profiles.
- An Account may have one or more `AuthIdentity` records (Apple, Google, email/password) linked to it — see §7 Profile/Identity Linking. `AuthIdentity` is a record of *which provider credentials* an Account has linked; it is never consulted to resolve *which Account* is calling — that resolution is always the direct `auth.uid() = account.id` comparison above. An Account's `auth.users.id` cannot change, so it cannot come to have more than one `id` value, and no two Accounts can ever share one `auth.users.id` — the primary key rules that out by construction.

---

## 3. Supported Sign-In Methods

- **Sign in with Apple** — via Supabase Auth's Apple provider. Handles Apple's private relay email and stable subject identifier; one-time name delivery is captured at first sign-in since Apple does not resend it.
- **Sign in with Google** — via Supabase Auth's Google (OAuth/OIDC) provider. The backend validates the identity token through Supabase Auth and links the provider identity to the Account; no separate token validation path is implemented.
- **Email/password** — created through Supabase Auth's email provider: email verification, secure password storage (hashing, rate limiting, no plaintext — all delivered by Supabase Auth, not reimplemented), and terms/privacy consent capture at signup.
- **Device biometrics (Face ID / Touch ID / Android biometric authenticators)** — available only *after* an initial Supabase Auth sign-in on that device. Biometric templates never leave the device OS. The app stores only local enablement metadata and a reference to the securely stored Supabase session credential — never the credential's raw form and never a biometric template.

Entry points: "Continue with Apple", "Continue with Google", "Create Account" (email), "Sign In" (existing email account). New accounts proceed to onboarding; existing accounts load their authorized Profiles.

---

## 4. Session Model

- Supabase Auth issues and refreshes the access/refresh token pair. No competing token system is introduced.
- Application-level `DeviceSession` records (per `29_Data_Model.md` §2) store **device/session metadata only** — used for session listing, revocation, logout-all, device awareness, last-activity, and security-event tracking. `DeviceSession` is never itself a credential or token authority; it references the Supabase session, it does not replace it.
- Session lifecycle operations (expiration, rotation, revocation, logout, logout-all) are performed through Supabase Auth's session APIs; `DeviceSession` rows are updated/invalidated in step with those operations, not independently of them.
- **`DeviceSession.revoked_at` is metadata only and is not itself enforced by RLS or any database policy.** No policy on any table checks it (confirmed by direct query/test, Layer 3 verification). Setting `revoked_at` without also invalidating the corresponding session through a real Supabase Auth call (e.g. `auth.admin.signOut(scope)` targeting that session, or the equivalent) does **not** block further use of an already-issued, still-unexpired Supabase access token — that token remains independently valid for its own remaining lifetime, which is inherent to any JWT-based system and not something the application schema controls. The API-layer implementation of logout / logout-all / lost-device revocation (out of scope for this document, deferred to the not-yet-built backend) must always perform the real Supabase Auth session invalidation as the actual revocation step, and update `DeviceSession` to reflect it — never treat marking `DeviceSession` revoked, alone, as having revoked access. This keeps Supabase Auth the single, authoritative session system; `DeviceSession` is not a second one.

---

## 5. Profile Context

- Profile context is **not** part of authentication. A request carries a single Supabase Auth Account token plus an explicit `profile_id` per `30_API.md` §4.
- The server authorizes Account→Profile access on every profile-scoped request (direct ownership or active `GuardianAuthorization` — see `33_Security_and_Privacy.md` §2). A `profile_id` is never trusted merely because the client supplied it.
- No separate authentication token is minted per Profile.

---

## 6. Child Authentication

- A child Profile does **not** independently authenticate in the initial version. There is no `AuthIdentity` for a child Profile.
- Child profiles are reached exclusively through an authorized guardian Account plus profile selection, gated by an active `GuardianAuthorization` record.
- Sensitive child actions (e.g. modifying a pediatric weight-management target, revoking guardian access) require a fresh reauthentication signal from the guardian's own Supabase Auth session (§8), not merely an already-open session.
- Independent child/teen login is out of scope unless a later specification explicitly approves it.

---

## 7. Profile/Identity Linking

- One Account may have multiple `AuthIdentity` records (e.g. a user who originally signed up with email later adds Sign in with Google) — confirmed by direct test in Layer 3 verification: linking a second provider to an already-provisioned Account inserts a second `auth_identity` row and creates no second `account` or `profile` row.
- Linking or merging identities requires proof of ownership of the identity being linked (Supabase Auth's identity-linking flow), never a linkage based solely on a matching email address without provider-verified proof.
- **Known gap — unlink is not yet mirrored automatically:** `public.auth_identity.unlinked_at` is today only ever set by a legitimate client-driven UPDATE (subject to the column-immutability trigger, §11); there is no trigger reacting to Supabase deleting the corresponding `auth.identities` row (Supabase's own documented unlink mechanism). Confirmed by direct test in Layer 3 verification: deleting an `auth.identities` row does not change `public.auth_identity.unlinked_at`. This is a display/audit-accuracy gap only, not an access-control gap — `auth_identity` (and `unlinked_at`) is never read by any RLS policy or authorization function (§2, §11) — but it means `unlinked_at` cannot yet be trusted as a complete record of provider unlink events end-to-end. Closing it (an `AFTER DELETE ON auth.identities` trigger setting `unlinked_at`) is a small, low-risk future addition, deferred rather than made now since it is not required by anything in scope for this document.

---

## 8. Account Recovery and Device Trust

- **Recovery**: password reset and verification-resend flows run through Supabase Auth. Social-provider (Apple/Google) recovery follows the provider's own account-recovery path; relinking a provider identity to an existing Account requires the same proof-of-ownership as initial linking (§7) — it never silently creates a second Account.
- **Device trust**: trusted-device metadata, per-device biometric enablement, lost-device revocation, and sensitive-action reauthentication are represented on `DeviceSession`. Lost-device revocation invalidates the corresponding Supabase session and marks the `DeviceSession` row revoked; it does not merely hide the device from a list.
- Sensitive-action reauthentication (§6, and account deletion/export per `33_Security_and_Privacy.md` §2.4) requires a recent/step-up Supabase Auth session check, not just a valid long-lived token.

---

## 9. Security Test Coverage (carried forward as a Phase 1 requirement, tests written in later phases)

At minimum, authentication test coverage must include: Apple sign-in, Google sign-in, email/password sign-in, password reset, identity linking (including a rejected/unproven linking attempt), token expiry and revocation, logout-all, biometric success and failure paths, and lost-device revocation. This requirement is recorded here; the tests themselves are written when authentication is implemented (Phase 1 implementation, not this document).

---

## 10. Out of Scope for Phase 1 Specification

- Literal Supabase Auth configuration (provider client IDs, redirect URIs, RLS policy SQL) — implementation detail, not specification.
- Independent child/teen authentication — excluded per §6 unless separately approved.
- Any second authentication or token system — explicitly prohibited by §1 and Master §7.2/§21/§34.

---

## 11. Account Provisioning (implemented)

Provisioning of `Account` and `AuthIdentity` rows is implemented as a **database trigger on Supabase Auth's own `auth.identities` table**, not application/API code — consistent with §1 (Supabase Auth is the sole authority) and with there being no backend project yet.

**Why `auth.identities`, not `auth.users`:** a new provider identity appears in `auth.identities` both on first signup (alongside a new `auth.users` row) and when an existing Account later links an additional provider (no new `auth.users` row). Triggering on `auth.identities` covers both cases with one mechanism, matching §7 (an Account may have multiple `AuthIdentity` records added over time).

**Why this requires no proof-of-ownership logic of its own:** `auth.identities` is populated exclusively by Supabase Auth's own verified OAuth/email flows — it is not client-writable. By the time a row appears there, Supabase has already verified the provider's proof. The trigger only mirrors an already-verified fact into `public.auth_identity`/`public.account`; it does not perform verification itself.

**Provisioning logic (per new `auth.identities` row):**
1. Map Supabase's `provider` string to the fixed `auth_identity_provider` enum (`email`/`google`/`apple`); ignore silently if it doesn't match one of the three approved methods (defensive — should not occur given Supabase project configuration limits enabled providers to these three).
2. Derive `provider_subject_id` from `identity_data->>'sub'` (the OIDC/OAuth subject claim, present for every Supabase identity regardless of internal schema version) — never from email.
3. `INSERT ... ON CONFLICT (id) DO NOTHING` into `account`, keyed on `auth.identities.user_id` (which is, by design, the same value as `account.id` — see §2). Idempotent and concurrency-safe: a race between two near-simultaneous provisioning attempts for the same user resolves to exactly one `account` row via the existing primary key.
4. `INSERT ... ON CONFLICT (provider, provider_subject_id) DO NOTHING` into `auth_identity`. Idempotent and concurrency-safe via the existing unique constraint (`29_Data_Model_Data_Dictionary.md` §2) — a repeated or retried callback can never create a duplicate.
5. If the Account has no `Profile` yet, create exactly one adult `Profile` (`is_child = false`). Never a child Profile — matches §6 and Master §10. Idempotent: gated on `not exists (select 1 from profile where account_id = ...)`.

**Anti-merge guarantee, by construction:** `account.id` is always `auth.identities.user_id` — a single Supabase-assigned UUID. Two different Supabase users who happen to share an email address are, and remain, two different `auth.users` rows and therefore two different `account` rows; nothing in this trigger, or anywhere else in the schema, ever keys off email for identity resolution or merging. Email-based Account merging would require a distinct, explicitly-designed, and separately-approved workflow — none exists, and none is implied by this mechanism.

**AuthIdentity column immutability:** once created, an `auth_identity` row's `account_id`, `provider`, `provider_subject_id`, and `linked_at` are frozen (enforced by trigger, `20260825122200_auth_identity_immutable_columns.sql`) — only `unlinked_at` may ever change. This closes a gap where an Account's ordinary RLS-permitted UPDATE on its own `auth_identity` row (originally scoped only to *which row*, not *which columns*) could otherwise rewrite the row's identity-defining fields after the fact.

---

## 12. External Configuration Still Required

Nothing below is implemented by this repository — each requires an external provider console and/or a live Supabase project, neither of which exists in this development environment. Recorded here as the exact remaining setup, not fabricated as done:

**Google:**
- A Google Cloud Console project with an OAuth 2.0 Client ID (Web application type, as Supabase's OAuth flow requires) and the correct authorized redirect URI (`https://<project-ref>.supabase.co/auth/v1/callback`).
- The resulting Client ID/Secret entered into the Supabase dashboard's Google provider configuration (Authentication → Providers → Google), enabling the provider.
- Mobile-side: the platform-specific OAuth client configuration (iOS/Android) for the native Google sign-in SDK flow, if a native (rather than web-redirect) flow is used.

**Apple:**
- An Apple Developer account with a registered App ID, a Services ID configured for Sign in with Apple, a Sign in with Apple key, and the associated Team ID/Key ID.
- These values entered into the Supabase dashboard's Apple provider configuration.
- The app's bundle identifier registered and associated with the Services ID for the native iOS flow.

**Supabase project (both providers, and email/password):**
- A live Supabase project (this environment has never been connected to one).
- The two new migrations in this Layer (§11) applied to that project via the Supabase CLI/migration pipeline.
- Email provider settings (confirmation email template, redirect URL, rate limits) reviewed in the dashboard — Supabase's defaults are used unless a product decision changes them; no such decision has been made yet.

None of the above can be completed from within this repository or this session — they require dashboard/console access this environment does not have.

---

## 13. Mobile Integration Contract (not implemented — no mobile project exists)

No mobile application exists in this repository yet (confirmed by direct inspection — no `package.json`, Expo project, or any application code is present). Per this Layer's scope, no screens or client code are built to "demonstrate" authentication. This section records the contract the eventual mobile client (`22_Mobile_Application.md`, not yet written) must satisfy, so that work starts from an agreed contract rather than inventing one ad hoc:

1. Use the Supabase client SDK (`@supabase/supabase-js` via Expo, or the native Supabase Swift/Kotlin SDK) for all three approved sign-in methods — never a hand-rolled OAuth or password flow.
2. Store only what the SDK itself manages in platform secure storage (iOS Keychain / Android Keystore, via Expo SecureStore or equivalent) — the client never independently persists a raw access or refresh token outside the SDK's own session storage.
3. After a successful sign-in, register a `DeviceSession` row (device name, device type, a reference to the SDK session — never the raw token) via an authenticated API call — this is an API-layer responsibility (`30_API.md`), not something the client fabricates locally.
4. Every subsequent API request carries the Supabase session's access token plus an explicit `profile_id` (§5) — the client never assumes the server will "remember" which Profile was last selected; Profile selection is re-sent, and re-validated server-side, every request.
5. Biometric unlock (§3) gates *local app reopening/action confirmation* only — it calls the platform biometric API and, on success, allows the already-stored SDK session to be used; it never itself authenticates against Supabase or creates any server-side credential.
6. Logout calls the SDK's sign-out, then marks the local `DeviceSession` row revoked via an authenticated API call before clearing local session state. Logout-all calls the SDK's global sign-out equivalent and expects the API to have marked every `DeviceSession` row for that Account revoked (§11 of `33_Security_and_Privacy.md`'s RLS input table already permits an Account to update all of its own `DeviceSession` rows in one statement).

This contract is a requirement for whichever future phase builds the mobile project — nothing here is implemented as mobile code.

## 14. Platform administration and identity providers (Phase 3 Layer 11C)

Platform administrators authenticate exactly like every other user — through Supabase Auth; there is no second authentication system, admin password or admin token. Authorization then follows Account → PlatformRoleAssignment (`platform_admin`) → administration APIs (`30_API.md` §29). Supabase Auth remains the only identity/token authority: Google Sign-In and Sign in with Apple are recorded in the integration registry (`identity` family, `connection_model: supabase_auth`) only as administrative definitions — they cannot be enabled, tested or routed there, and their availability and credentials are configured in Supabase Auth (§12).

## 15. Provider platform credentials (Phase 3 Layer 11D)

FatSecret's OAuth 2.0 **client-credentials** grant is a server-to-server platform credential, not user authentication: it never involves a user, a Supabase session or the mobile app. The client id/secret are deployment secrets resolved by the API; the resulting access token is held in API memory only. Open Food Facts reads need no credential (an identifying User-Agent only). Users calling the external-product endpoints authenticate with their normal Supabase session; no provider identity is created or linked for them.
