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
- **Profile** selection identifies whose nutrition context is being accessed, and is supplied separately from authentication (see `30_API.md` §4).
- An Account may have one or more permitted Profiles.
- An Account may have one or more `AuthIdentity` records (Apple, Google, email/password) linked to it — see §7 Profile/Identity Linking.

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

- One Account may have multiple `AuthIdentity` records (e.g. a user who originally signed up with email later adds Sign in with Google).
- Linking or merging identities requires proof of ownership of the identity being linked (Supabase Auth's identity-linking flow), never a linkage based solely on a matching email address without provider-verified proof.

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
