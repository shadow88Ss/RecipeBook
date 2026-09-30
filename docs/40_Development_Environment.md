# 40 — Development Environment, Live Verification & Real-Device Testing (Phase 4 Layer 12A.1)

This is the runbook for the first live development environment: one Supabase development project, one development API reachable over HTTPS, and the mobile app on a physical phone through Expo Go. It never contains secret values. Every value marked *secret* goes only into the hosting provider's secret settings or a local, git-ignored `.env`.

Status when this was written: **none of it exists yet.** No Supabase project, no deployed API and no phone test. Section 9 lists what is live-verified and what is mock-verified only.

---

## 1. Supabase development project

1. Create a project at supabase.com for **development only**, e.g. `myrecipebook-dev`. Do not use a production project for the first phone tests.
2. **JWT signing keys.** Open *Project Settings → JWT Keys*.
   - A new project uses asymmetric JWT signing keys (ES256) by default. Keep that. The API's mode is then `SUPABASE_JWT_VERIFICATION=jwks`.
   - If the project still shows only the "Legacy JWT secret", migrate it to JWT signing keys. While old HS256 tokens are still live, the API can run `jwks_with_legacy_hs256`, then switch to `jwks`.
   - Check the key yourself:
     - `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` must list at least one key (`"alg": "ES256"` or `"RS256"`);
     - an empty `keys` array means the project still signs with the legacy secret.
3. **API keys.** Open *Project Settings → API Keys* and note:
   - the project URL;
   - the anon key or `sb_publishable_…` key. It is public, and both the app and the API use it.
   - Never copy the `service_role` / `sb_secret_…` key anywhere in this project.
4. **Auth settings.** Open *Authentication → Providers*.
   - Email is enabled by default.
   - For the first alpha, either keep "Confirm email" on and confirm the test users by email, or create them from the dashboard with "Auto Confirm User".
   - Leave Google, Apple and anonymous sign-in off.

## 2. Apply the migrations

The schema is defined only by `supabase/migrations/` (45 files). Never recreate objects by hand in the dashboard.

```bash
npm install -g supabase            # or: npx supabase@latest …
cd <repo root>
supabase init                      # creates supabase/config.toml; keep the existing migrations
supabase login
supabase link --project-ref <ref>  # asks for the database password (secret; not stored in the repo)
supabase db push --dry-run         # review: must list all 45 migrations, in order
supabase db push
supabase migration list            # local and remote columns must match
```

Verify in the SQL editor. These are read-only queries.

```sql
-- tables with RLS enabled (every app table must show rowsecurity = true)
select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1;
-- policies exist
select tablename, count(*) from pg_policies where schemaname = 'public' group by 1 order by 1;
-- the auth provisioning trigger (on auth.identities, 37_Auth §11)
select tgname from pg_trigger where tgrelid = 'auth.identities'::regclass and not tgisinternal;  -- on_auth_identity_created
-- functions
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1;
```

If `db push` fails, or RLS or grants differ from the local chain: **stop.** Do not patch the schema in the dashboard, and report it. This is a stop condition of Layer 12A.1.

## 3. Test users (normal Supabase Auth)

Create two email/password users through Supabase Auth, either the dashboard *Authentication → Users → Add user* or the app's sign-in with an existing user. Do **not** insert Account or Profile rows by hand.

- **User A:** the phone test user.
- **User B:** an unrelated account, used for the cross-account RLS checks.

For each user, check that provisioning ran (`37_Authentication_and_Login.md` §11):

```sql
select a.id = u.id as account_matches_auth_user, p.id as default_profile
from auth.users u join account a on a.id = u.id join profile p on p.account_id = a.id
where u.email = '<user email>';
```

## 4. Deploy the development API

Any host that runs a Node 22 container with HTTPS works (for example Render, Fly.io, Railway or Google Cloud Run). `api/Dockerfile` builds a production image: `npm ci --omit=dev`, then `node dist/index.js`, running as a non-root user. The image has **not** been built here, because no Docker daemon was available.

Environment settings on the host (server-side only):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (enforces an https JWKS URL) |
| `PORT` | whatever the host assigns (default 3000) |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | the anon / publishable key |
| `SUPABASE_JWT_VERIFICATION` | `jwks` (see §1.2) |
| `SUPABASE_JWT_SECRET` | *secret*; only for the legacy modes; otherwise unset |
| `LOG_LEVEL` | `info` |

Never set a service-role key, the database password or a provider secret for this layer. FatSecret and Open Food Facts are not needed. The API stays up with providers unconfigured, and those routes answer `503`.

Do not expose the local PostgreSQL test harness. It exists only under `api/tests/`. The deployed API talks to Supabase over HTTPS with each caller's own token.

Check the deployment:

```bash
curl -i https://<dev-api-host>/health             # 200
curl -i https://<dev-api-host>/v1/profiles        # 401 UNAUTHENTICATED
```

## 5. Live smoke test (API ↔ Auth identity, failure cases, RLS)

Run from any machine. It signs in through normal Supabase Auth and never prints tokens or passwords.

```bash
cd api
LIVE_API_BASE_URL=https://<dev-api-host> \
LIVE_SUPABASE_URL=https://<ref>.supabase.co \
LIVE_SUPABASE_ANON_KEY=<anon or publishable key> \
LIVE_USER_A_EMAIL=<a> LIVE_USER_A_PASSWORD=<secret> \
LIVE_USER_B_EMAIL=<b> LIVE_USER_B_PASSWORD=<secret> \
npm run test:live-env
```

It checks:

- `/health`.
- The token's algorithm and issuer.
- `GET /v1/profiles` with a real token: the Account id equals the Supabase user id, and the default Profile exists.
- The same call is refused with `401` for no token, a malformed token, a tampered signature and `alg: none`.
- The Daily Tracker returns no invented values (unavailable values are `null`).
- Progress returns three factual sections and `combined_score: null`.
- An SDK refresh produces a new token that the API accepts.
- User A and user B cannot see each other's Profiles, either through the API (`404`) or through PostgREST with RLS.
- Sign-out revokes the refresh token.

Optional: set `LIVE_EXPIRED_TOKEN` to a saved token from this project that has expired, to add the expired-token check.

Wrong issuer and wrong audience cannot be minted without the project's private key. They are covered locally with real ES256/RS256 keys (`tests/unit/accessTokenVerifier.test.ts`, `tests/integration/layer12a1.auth.api.test.ts`).

Not covered by the script:

- `view_only` write blocking and revoked-guardian access. Grants cannot be created through the API yet. To check them on the live project, create a grant in the SQL editor, sign in as the grantee and repeat the calls.

## 6. Mobile development environment

`mobile/.env.local` is git-ignored and holds public values only (`mobile/README.md#environment`):

```
EXPO_PUBLIC_APP_ENV=development
EXPO_PUBLIC_API_BASE_URL=https://<dev-api-host>
EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon or publishable key>
EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS=
```

`app.config.ts` refuses secret-looking variables and `sb_secret_`/service-role keys, and requires HTTPS outside development.

**After changing any `EXPO_PUBLIC_*` value, restart with a cleared cache: `npx expo start -c` (or `expo export --clear`).** Metro caches compiled files with the old values inlined. In Layer 12A.1, an export without `--clear` still carried the previous API URL.

## 7. Phone test with Expo Go (first smoke test)

1. Install **Expo Go** (SDK 57) on the phone.
2. Run `cd mobile && npm install && npx expo start`. Use `--tunnel` if the phone and computer are on different networks.
3. On iPhone, scan the QR code with the Camera app. On Android, scan it from Expo Go.
4. Record each item as it is actually tested:

| # | Check | Expected |
|---|---|---|
| 1 | Launch | sign-in screen; no "App configuration problem" |
| 2 | Sign in as user A | Today opens (single Profile auto-selected) |
| 3 | Today | today's date; five nutrients; "Not available" (not 0) for unknown values; "Nothing logged for this day." on an empty day; target context line |
| 4 | Progress | three sections; "No confirmed planned items", "No weight measurements" on a new Profile; no score |
| 5 | Kill and reopen the app | still signed in (session restored from Keychain/Keystore) |
| 6 | Leave the app open more than 1 hour, or background it and return | requests still succeed (SDK refresh) |
| 7 | Airplane mode, then pull Today / press Try again | "You appear to be offline" with Try again; **still signed in** |
| 8 | Stop the API (or point at a dead host) | server/unavailable message; **still signed in** |
| 9 | Sign out | sign-in screen; reopening the app stays signed out |
| 10 | Several Profiles (optional) | selection screen with access labels |

## 8. Development build (EAS) — prepared, not built

Expo Go covers the alpha. For the barcode camera (12B) and later native health integrations:

- `mobile/eas.json` has `development`, `development-simulator` and `preview` profiles. There is no production or submit profile.
- A development build first needs:
  - `npx expo install expo-dev-client`;
  - an Expo account (`npx eas-cli@latest login`);
  - EAS environment variables for the `EXPO_PUBLIC_*` values (EAS "development" environment);
  - Apple Developer / Google Play accounts for device builds, and real bundle ids.
- Then run `npx eas-cli@latest build --profile development --platform ios|android`.
- Nothing is submitted to the stores.

## 9. Live-vs-mock verification matrix

Update this table when a live run happens: record the date, and the device and OS for phone tests.

| Area | Status | Evidence |
|---|---|---|
| Supabase Auth (sign-in, restore, refresh, sign-out) | MOCK VERIFIED ONLY | mobile tests run the real supabase-js against a scripted Auth endpoint |
| API JWT verification: JWKS ES256/RS256 | MOCK VERIFIED ONLY (real crypto, local JWKS) | `accessTokenVerifier.test.ts`, `layer12a1.auth.api.test.ts`, built-entrypoint smoke |
| API JWT verification against the live project | NOT TESTED | `npm run test:live-env` |
| Profiles API | MOCK VERIFIED ONLY | local Postgres + RLS harness; mobile tests |
| Daily Tracker | MOCK VERIFIED ONLY | same |
| Progress | MOCK VERIFIED ONLY | same |
| Real-project RLS | NOT TESTED | live smoke §28 block |
| Migrations on Supabase | NOT TESTED | local chain from zero only |
| Physical iPhone | NOT TESTED | §7 checklist |
| Physical Android | NOT TESTED | §7 checklist |
| Development build (EAS) | NOT TESTED | §8 |
| FatSecret | NOT TESTED (not required for 12A.1) | Layer 11D opt-in live smoke |
| Open Food Facts | NOT TESTED (not required for 12A.1) | Layer 11D opt-in live smoke |
