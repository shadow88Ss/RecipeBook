# 40 — Development Environment, Live Verification & Real-Device Testing (Phase 4 Layer 12A.1)

This is the runbook for the first live development environment: one Supabase development project, one development API reachable over HTTPS, and the mobile app on a physical phone through Expo Go. It never contains secret values. Every value marked *secret* goes only into the hosting provider's secret settings or a local, git-ignored `.env`.

Status: the DEV project, the Render API and a first Expo Go launch exist (2026-10-02). Section 9 lists what is live-verified and what is mock-verified only.

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

The schema is defined only by `supabase/migrations/` (46 files). Never recreate objects by hand in the dashboard.

```bash
npm install -g supabase            # or: npx supabase@latest …
cd <repo root>
supabase init                      # creates supabase/config.toml; keep the existing migrations
supabase login
supabase link --project-ref <ref>  # asks for the database password (secret; not stored in the repo)
supabase db push --dry-run         # review: must list exactly the migrations not yet applied, in order
supabase db push
supabase migration list            # local and remote columns must match
```

`supabase init` also creates `supabase/.gitignore` and `supabase/config.toml`. They are local environment configuration: do not commit them.

### 2.1 Supabase default privileges (why migration 46 exists)

A hosted Supabase project runs `alter default privileges for role postgres in schema public grant all on tables, functions, sequences to anon, authenticated, service_role`. Every object that migrations 1-45 create therefore also gets ALL for `anon` and `authenticated`, on top of the explicit grants in each migration. `revoke … from public` does not remove a direct role grant.

On the first DEV deployment (Layer 12A.1), this gave `anon` the following, which the local chain never had:

- table privileges on every table (RLS still filtered the rows, since every policy is `to authenticated`);
- EXECUTE on internal helpers such as `meal_item_chain_root` and `enabled_provider_routes`.

`20261014120000_align_supabase_default_privileges.sql` changes privileges only. It:

- revokes those default privileges for future objects;
- revokes every direct privilege that `anon` and `authenticated` hold on public tables, sequences and routines;
- re-grants exactly the validated set.

It does not touch `service_role`.

Since that migration, the local harness applies `api/tests/fixtures/supabase-default-privileges.sql` before the first migration, so the local chain is built under the same defaults. `tests/integration/layer12a1.privileges.test.ts` pins the model below, and it fails if migration 46 is removed. **New migrations must keep granting explicitly** (`revoke … from public` plus `grant … to authenticated`). Nothing is granted automatically any more.

### 2.2 Verify the live schema (read-only; SQL editor)

```sql
with t as (select c.oid, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'),
f as (select p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig, p.prosecdef, p.prorettype = 'trigger'::regtype as is_trigger from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
privs as (select unnest(array['SELECT','INSERT','UPDATE','DELETE']) as priv)
select 'A tables' as check_name, count(*)::text as value from t
union all select 'B tables_without_rls', coalesce(string_agg(relname, ',' order by relname), 'none') from t where not relrowsecurity
union all select 'C policies', count(*)::text from pg_policies where schemaname = 'public'
union all select 'D policy_fingerprint', md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || array_to_string(roles, '+'), ',' order by tablename, policyname)) from pg_policies where schemaname = 'public'
union all select 'E functions', count(*)::text from f
union all select 'F function_fingerprint', md5(string_agg(sig || '|' || prosecdef, ',' order by sig)) from f
union all select 'G triggers', count(*)::text from pg_trigger tg join t on t.oid = tg.tgrelid where not tg.tgisinternal
union all select 'H trigger_fingerprint', md5(string_agg(t.relname || '|' || tg.tgname, ',' order by t.relname, tg.tgname)) from pg_trigger tg join t on t.oid = tg.tgrelid where not tg.tgisinternal
union all select 'I auth_identities_triggers', coalesce(string_agg(tgname, ',' order by tgname), 'none') from pg_trigger where tgrelid = 'auth.identities'::regclass and not tgisinternal
union all select 'J anon_table_privileges', count(*)::text from t, privs where has_table_privilege('anon', t.oid, privs.priv)
union all select 'K authenticated_table_privileges', count(*)::text from t, privs where has_table_privilege('authenticated', t.oid, privs.priv)
union all select 'L authenticated_privilege_fingerprint', md5(string_agg(t.relname || '|' || privs.priv, ',' order by t.relname, privs.priv)) from t, privs where has_table_privilege('authenticated', t.oid, privs.priv)
union all select 'M anon_executable_functions', count(*)::text from f where not is_trigger and has_function_privilege('anon', f.oid, 'EXECUTE')
union all select 'N authenticated_executable_functions', coalesce(string_agg(sig, ', ' order by sig), 'none') from f where not is_trigger and has_function_privilege('authenticated', f.oid, 'EXECUTE')

union all select 'O default_privileges_to_anon_or_authenticated', coalesce(string_agg(distinct case d.defaclnamespace when 0 then 'all_schemas' else 'public' end || ':' || d.defaclobjtype::text || ':' || x.grantee::regrole::text, ','), 'none') from pg_default_acl d cross join aclexplode(d.defaclacl) x where d.defaclrole = 'postgres'::regrole and d.defaclnamespace in (0, 'public'::regnamespace) and x.grantee in ('anon'::regrole, 'authenticated'::regrole)
order by 1;
```

Expected (identical for a clean local build and for the live project):

| Check | Expected |
|---|---|
| A tables | `56` |
| B tables_without_rls | `none` |
| C policies | `139` |
| D policy_fingerprint | `9dabbfc03377a67fe0e18541b05ccd77` |
| E functions | `69` |
| F function_fingerprint | `5e87f01de9c92c62c6eb1a6564564f49` |
| G triggers | `83` |
| H trigger_fingerprint | `141516ac388d47733b9c5994a076c3d5` |
| I auth_identities_triggers | `on_auth_identity_created` |
| J anon_table_privileges | `0` |
| K authenticated_table_privileges | `117` |
| L authenticated_privilege_fingerprint | `a955e41b8f25396d503190c33ac443f1` |
| M anon_executable_functions | `2` (the two `gtin_*` helpers) |
| N authenticated_executable_functions | the 20 functions below |
| O default_privileges_to_anon_or_authenticated | `none` |

N, in order:

- `admin_register_external_provider(p_provider jsonb)`
- `admin_update_external_provider(p_provider_key text, p_change jsonb)`
- `can_manage_recipe(target_recipe_id uuid)`
- `can_read_recipe(target_recipe_id uuid)`
- `confirm_meal_plan(p_profile_id uuid, p_meal_plan_id uuid, p_payload jsonb)`
- `correct_meal_item(p_profile_id uuid, p_meal_log_id uuid, p_original_id uuid, p_item jsonb, p_correction_reason text)`
- `create_recipe_version(p_profile_id uuid, p_recipe_id uuid, p_expected_current_version_id uuid, p_content jsonb)`
- `current_account_id()`
- `enabled_provider_routes(p_family provider_family, p_capability text)`
- `external_provider_audit_history(p_provider_id uuid)`
- `external_provider_connection_counts()`
- `generate_grocery_list(p_profile_id uuid, p_meal_plan_id uuid, p_payload jsonb)`
- `gtin_check_digit_valid(p_code text)`
- `gtin_is_product_identity(p_gtin text)`
- `is_child_profile_created_by_caller(target_profile_id uuid)`
- `is_platform_admin()`
- `log_meal_items(p_profile_id uuid, p_meal_log_id uuid, p_payload jsonb)`
- `profile_access_scope(target_profile_id uuid)`
- `search_foods(p_query text, p_locales text[], p_limit integer)`
- `write_planned_meal_items(p_profile_id uuid, p_meal_plan_id uuid, p_meal_plan_day_id uuid, p_planned_meal_id uuid, p_payload jsonb)`

With only migrations 1-45 applied, a hosted project shows the following. This is the drift:

| Check | Value |
|---|---|
| J | `224` |
| K | `224` |
| L | `8e7cd9bc14eed06fb886058d1d4df6f3` |
| M | `26` |
| O | six entries |

A-I are unchanged.

If `db push` fails, or any value differs from the expected table: **stop.** Do not patch the schema or grants in the dashboard, and report it. This is a stop condition of Layer 12A.1.

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

Last live run: 2026-10-01/02 on DEV project `psundpxqgiknxnjudmxv` (Singapore), with the API on Render (Starter, Singapore, commit `d9ab3b7`).

| Area | Status | Evidence |
|---|---|---|
| Migrations on Supabase | LIVE VERIFIED | 46/46 applied; §2.2 checks A–O match the reference build (after migration 46) |
| Real-project RLS | LIVE VERIFIED | SQL-editor cross-account check as both users; `npm run test:live-env` §28 (API + PostgREST) |
| Auth provisioning (Account, AuthIdentity, default Profile) | LIVE VERIFIED | 2 users created through Supabase Auth; provisioning query |
| API JWT verification against the live project (ES256/JWKS) | LIVE VERIFIED | `npm run test:live-env`: 14 passed, 1 skipped (expired-token check, optional) |
| Supabase Auth (sign-in, refresh, sign-out revocation) | LIVE VERIFIED (API/SDK) | same run |
| Profiles, Daily Tracker, Progress APIs | LIVE VERIFIED (read paths) | same run (empty-day values null, no combined score) |
| API deployment `/health`, unauthenticated `401` | LIVE VERIFIED | browser checks against the Render URL |
| Physical iPhone (iPhone 16 Pro, Expo Go SDK 57) | PARTIAL | app launched to the sign-in screen; §7 items 2–10 not yet reported |
| Physical Android | NOT TESTED | §7 checklist |
| Mobile food/product search, preview, logging (12B) | MOCK VERIFIED + LOCAL REAL-API CONTRACT CHECK | mobile tests; mobile request builders and response schemas run once against the real API on the local Postgres/RLS harness with test fixtures |
| Mobile barcode camera (12B) | NOT TESTED on a device | camera is replaced by a stand-in in tests; lookup contract checked locally |
| Reference data (Foods, Products) on DEV | NONE | no trusted ingestion workflow exists; DEV searches return no results (§10) |
| Development build (EAS) | NOT TESTED | §8 |
| FatSecret / Open Food Facts | NOT TESTED (not configured on DEV) | Layer 11D opt-in live smoke |

## 10. Reference data on a new environment

Foods, Food servings and nutrients, Products, label versions and barcodes are global reference data. Only a trusted ingestion workflow may write them, and none exists yet. The nutrient vocabulary is the one exception: it is seeded by a migration. So a new project has **no searchable Foods or Products**: mobile search shows "No foods found…", and a barcode scan finds nothing (or only an unconfirmed external candidate, if providers are configured).

Do not insert Foods or Products by hand in the dashboard, and do not copy the API test fixtures into a real project. Making DEV searchable needs an approved, reviewed ingestion path (source dataset, licence, provenance, service-role execution outside the app). That is a separate decision.
