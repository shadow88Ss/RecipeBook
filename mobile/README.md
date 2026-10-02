# MyRecipeBook mobile (alpha foundation)

The iOS and Android app for MyRecipeBook: React Native, Expo SDK 57, TypeScript and Expo Router. This is the Phase 4 Layer 12A foundation: sign-in, Profile selection, Today (Daily Tracker) and Progress connected to the `/v1` API, with the other areas as shells.

> Status: the app has only been tested with mocked Supabase and API responses. The live setup and phone checklist are in `docs/40_Development_Environment.md`. It has **not** been run against a live Supabase project or a deployed API, and not on a physical device. See [External configuration still required](#external-configuration-still-required).

## Contents

- [Structure](#structure)
- [Environment](#environment)
- [Auth flow](#auth-flow)
- [API client](#api-client)
- [Profile context](#profile-context)
- [Navigation](#navigation)
- [Today](#today)
- [Progress](#progress)
- [Log and barcode](#log-and-barcode)
- [State](#state)
- [Secure storage](#secure-storage)
- [Security rules](#security-rules)
- [Checks](#checks)
- [Running on a real phone](#running-on-a-real-phone)
- [Expo Go or a development build](#expo-go-or-a-development-build)
- [External configuration still required](#external-configuration-still-required)

## Structure

```
mobile/
  app.config.ts          Expo config; validates the environment when Expo loads it
  .env.example           the public variables (copy to .env.local)
  src/
    app/                 routes (Expo Router): _layout, sign-in, select-profile, (app)/(tabs)/…
    config/              env.js (+ env.d.ts) validation shared by app.config.ts and the app
    auth/                supabase-js auth client, secure storage adapter, auth service, AuthProvider, OAuth browser
    api/                 the one API client, error mapping, endpoints, contracts/ (zod DTOs from docs/30_API.md)
    profile/             ProfileProvider (selection context) and scope labels
    features/            screens: auth, profile, today, progress, log (search, log item, scan), misc (more, settings, placeholders)
    barcode/             barcode lookup contract and API call (the camera is features/log/CameraScanner)
    state/               services wiring, provider tree, TanStack Query client, navigation gate
    ui/                  theme and UI kit (Screen, Text, Button, Input, Card, Loading/Error/Empty, Notice)
    i18n/                English catalogue, t(), number formatting, RTL flag
    lib/                 dates (local day in an IANA zone), redacting dev logger
  __tests__/             Jest (jest-expo) tests with mocked Supabase Auth and API
```

It is a standalone npm project next to `api/`. There is no workspace or shared package: the mobile DTOs are written from `docs/30_API.md`, and no backend code is imported. The monorepo layout in `docs/00_Master.md` §4 is still the preferred future shape.

## Environment

All configuration is public, set through `EXPO_PUBLIC_*` variables that Expo compiles into the bundle. Copy `.env.example` to `.env.local` (git-ignored) and fill it in. After changing any value, restart with `npx expo start -c`: Metro caches compiled files with the old values inlined.

| Variable | Required | Notes |
|---|---|---|
| `EXPO_PUBLIC_APP_ENV` | yes | `development`, `staging` or `production`. No default. |
| `EXPO_PUBLIC_API_BASE_URL` | yes | API origin **without** `/v1`. HTTPS required outside development. |
| `EXPO_PUBLIC_SUPABASE_URL` | yes | The Supabase project for the same environment as the API. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | yes | The anon JWT or `sb_publishable_…` key. |
| `EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS` | no | `google`, `apple` (comma-separated) once they are configured in Supabase. |

Validation runs twice: when Expo loads `app.config.ts` (start, export, EAS build), which stops with a list of problems, and when the app starts, which shows a configuration-error screen instead of the app. It never falls back to another environment. It refuses:

- a missing or unknown environment id;
- non-HTTPS URLs outside development, and `localhost` outside development (a warning in development, because a phone cannot reach it);
- an API URL that already ends in `/v1`, or contains credentials or a query;
- a service-role JWT or an `sb_secret_…` key as the anon key;
- any `EXPO_PUBLIC_*` variable whose name looks like a secret (`SECRET`, `SERVICE_ROLE`, `PASSWORD`, `PRIVATE`, `FATSECRET`, `WHOOP`, `DATABASE_URL`, `JWT`).

**Never put these in the app:** the Supabase service-role/secret key, the database password, the Supabase JWT secret, FatSecret or any provider secret, WHOOP secrets. They belong to the API's server environment only.

Bundle identifiers are placeholders: `com.myrecipebook.app.dev`, `com.myrecipebook.app.staging` and `com.myrecipebook.app`, with matching schemes `myrecipebook-development`, `myrecipebook-staging` and `myrecipebook`.

## Auth flow

Supabase Auth is the only auth authority. The app uses the official `@supabase/supabase-js` client, and only its `auth` module is used (`src/auth/supabaseAuth.ts`); no data goes through Supabase from the app.

- **Launch:** the stored session is restored from secure storage (`getSession`). While that runs, a "Checking your session" screen shows.
- **Sign in:** email and password through `signInWithPassword`. Errors are mapped to friendly messages; the password is cleared from the form on failure and is never stored or logged. There is no sign-up screen in this layer.
- **Google / Apple:** a PKCE flow through the in-app browser is wired (`signInWithOAuth` → `openAuthSessionAsync` → `exchangeCodeForSession`), but the buttons only appear when `EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS` lists a provider. Neither provider is configured yet (external configuration), so neither is claimed to work. Native Sign in with Apple is not built.
- **Refresh:** supabase-js refreshes tokens itself. The app starts auto-refresh while in the foreground and stops it in the background, and reads the session from Supabase for every API request (`getSession` refreshes when needed). There is no second refresh implementation.
- **Sign out:** the SDK sign-out (revokes the refresh token when the network is available), then the secure session keys are wiped and the in-memory API cache is cleared, even if the network call fails.
- **API 401:** treated as an ended session. The local session is cleared, cached data is dropped, and the sign-in screen shows "Your session has ended".
- **Outages are not auth failures:** offline, timeouts, 5xx and 503 (including the API failing to fetch Supabase signing keys) show an error with Try again and keep the user signed in.

Not built yet: `DeviceSession` registration (no API endpoint exists), biometric unlock.

## API client

`src/api/client.ts` is the only way the app calls the backend.

- URL: `${EXPO_PUBLIC_API_BASE_URL}/v1/...`. Only `/v1/` paths are allowed, and `/v1/admin/*` is refused before any network call.
- Headers: `Authorization: Bearer <Supabase access token>`, `X-Request-Id` (an opaque id), `Accept: application/json`, and `Content-Type: application/json` when there is a body. The account id is never sent.
- Timeout: 15 seconds by default.
- Every response body is checked against a zod schema from `src/api/contracts/`. A body that does not match becomes an `invalid_response` error.
- Errors become an `ApiError` with a `kind`: `validation` (400), `unauthenticated` (401 or no session), `forbidden` (403), `not_found` (404), `conflict` (409), `rate_limited` (429, with `Retry-After`), `unavailable` (503), `server` (500 and others), `timeout`, `offline`, `invalid_response`. Screens show a translated message for the kind and the request id as a reference. Server messages, stack traces and SQL are never shown or kept.

## Profile context

After sign-in the app calls `GET /v1/profiles` (following the pagination cursor).

- One Profile: it is selected automatically.
- Several: a selection screen lists them with their access scope ("Full access", "View only", "Pediatric care access").
- None: an empty state.

The context holds only the selected Profile's id, display name and `access_scope` as the API returned it. It is display context, not authorization. The app does not hide or allow anything based on scope: every request carries the Profile id in the path and the API decides. A selection belongs to the user who made it, so another user never inherits it.

## Navigation

The root layout (`src/app/_layout.tsx`) uses `Stack.Protected` guards driven by `navigationGate()`:

- **Auth flow:** `sign-in`.
- **Profile selection:** `select-profile` (signed in, no Profile chosen).
- **App flow:** tabs for Today, Log, Progress, More and Profile. More opens Recipes, Meal plan and Grocery list, which are placeholders in this layer.

## Today

`GET /v1/profiles/{id}/daily-tracker?date=&timezone=` for the device's local day and IANA time zone, with previous/next-day buttons (never past today).

- Shows energy, protein, carbohydrate, fat and fiber exactly as the API reports them.
- Coverage is always spelled out: "Complete", "Partial: 2 of 3 items have data", or "No data available".
- An unknown value shows "Not available", never 0. A day with nothing logged shows the API's known zeros and "Nothing logged for this day."
- The target line keeps the API's context: current targets, targets saved for this day, or "Targets for this day were not saved, so there is no comparison".
- Comparison wording comes from the API's `comparison_status` and its numbers (`remaining`, `remaining_at_most`, `over_target_by`, `over_target_by_at_least`). The app does no nutrition arithmetic.

## Progress

`GET /v1/profiles/{id}/progress?from=&to=&timezone=` for the last 7 local days. It shows three separate sections, as reported:

- **Meal plan follow-through:** each rate's count, denominator and percentage, or "No confirmed planned items" when there are none.
- **Nutrition against saved daily targets:** days with food and with saved targets, and per nutrient the comparable days and the average percentage of target (comparable days only).
- **Weight:** first and latest measurement, change, and the difference from goal weight.

There is no combined score and no judgement wording. The contract rejects a non-null `combined_score`.

## Log and barcode

Layer 12B. The flow is: Today → **Log food** → search → pick an item → amount and meal → server preview → **Log it** → back to Today, which re-reads the Daily Tracker.

**Search.** The Log tab searches either generic **Foods** (`GET /v1/foods`, Layer 5A) or **branded products** (`GET /v1/products`, Layer 11A). Results are shown as the API returns them:
- each row is labelled "Generic food" or "Branded product · brand", so the two kinds are never confused;
- products show their market, package size and active barcodes;
- a Food matched only through a suggested (AI) alias says so.

**Amount.** The amount is either a count of one of the item's servings (Food servings, or the current label's Product servings), or a quantity in a unit code from the server's registry (`GET /v1/units`). The offered units are g, kg, oz, lb, ml, l, US cup, tbsp, tsp and fl oz, each shown only if the server lists it. Typed amounts accept a decimal comma. Zero, negative and non-numeric amounts are refused before any request.

**Meal type.** Breakfast, lunch, dinner, snack or other: the API enum, with no default, so the user chooses.

**Preview.** The server calculates the nutrition for the chosen amount:
- `POST /v1/nutrition/calculate` for a Food;
- `POST /v1/products/{id}/nutrition/calculate` for a Product.

The preview shows the five summary values with their coverage, exactly like Today: an unknown value is "Not available", never 0. A Product without a label version cannot be logged, and an unverified label is called out. Nothing is calculated on the device.

**Logging.** `POST /v1/profiles/{id}/meals` with:
- the meal type;
- today's local date and IANA time zone;
- `consumed_at` (now);
- one item: `food_id`, or `product_id` / `barcode`, plus a quantity and exactly one of a unit or a serving.

No nutrition is sent: the server recalculates and stores the item's snapshot. A Product found by scanning is logged by its barcode, so the server records which barcode was used. After a successful log, `invalidateAfterNutritionWrite()` makes every cached day of that Profile's Daily Tracker and Progress re-read from the API.

**Access.** Only scopes the API allows to log meals (`full_management`, `pediatric_weight_management`) get the Log, search, scan and Log-it UI. `view_only` and unknown scopes get a read-only notice. The server enforces this regardless (`403`/`404`).

**Barcode scanning.** `CameraScanner` uses `expo-camera`, which is included in Expo Go SDK 57:
- it reads product symbologies only (EAN-13/8, UPC-A/E, ITF-14) and passes on the raw text, once per code;
- manual entry is always available, including when the camera is denied;
- `lookupBarcode()` sends the raw string to `GET /v1/products/barcode/{code}/lookup`, and the API normalizes it and runs the internal-first lookup.

There are three possible results:
- **Internal Product.** It is shown with **Log this product** (normal Product logging).
- **External candidate.** It is shown as **"Not yet in MyRecipeBook"**: unconfirmed provider information, with the provider's attribution, licence and link. It has **no log action**, and a response claiming a loggable candidate is rejected as an invalid contract. No candidate→Product confirmation workflow exists yet, so a candidate cannot be used until trusted ingestion adds it.
- **Nothing found.** The screen also says when outside sources could not be checked.

**Reference data.** Food and Product rows are global reference data written only by trusted ingestion, and no ingestion workflow exists yet. A new Supabase project therefore has no Foods or Products: searches return "No foods found…", and scans return "not found" (or an external candidate when providers are configured). Test fixtures exist only in the API test harness.

**Not in 12B:** correcting a logged item (the API's correction endpoint exists; the UI has no logged-item list to start from yet), Recipe, Meal Plan and Grocery UI, AI logging, health integrations.

## State

- **Auth state** (`AuthProvider`): status, user id and email only. Tokens stay inside supabase-js.
- **Selected Profile** (`ProfileProvider`): kept in memory.
- **Server state:** TanStack Query, in memory only (never persisted). It provides loading, error, retry and cancellation without hand-written caching. The cache is never authoritative and is cleared on sign-out and on a 401. `invalidateAfterNutritionWrite()` re-reads a Profile's Daily Tracker and Progress after writes (for Layer 12B onwards).
- **UI state:** local to each screen.

## Secure storage

`src/auth/secureStorage.ts` is the storage adapter supabase-js uses for its session.

- Values go to the iOS Keychain / Android Keystore through `expo-secure-store`, never AsyncStorage.
- A session is split into chunks of up to 1,800 characters. The chunk count is written last, so a partial write reads as "no session" rather than a corrupted one.
- Items use `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: readable only when the device is unlocked, and never migrated to another device.
- Android backup is disabled (`allowBackup: false` and the secure-store plugin's backup rules).
- Sign-out and a 401 wipe every session key.

## Security rules

- No service-role, secret or provider key in the app; the config refuses them.
- No direct calls to FatSecret, Open Food Facts, WHOOP or retailers.
- No admin UI and no admin API calls.
- No third-party analytics or crash-reporting SDKs.
- No `console` logging except the development-only logger in `src/lib/logger.ts`, which drops everything in release builds and redacts token, password, secret, session and email fields. Nutrition payloads are never logged.
- TLS verification is never disabled. Hosted environments must use HTTPS.

`__tests__/security.test.ts` checks these rules against the source and `package.json`, and ESLint blocks Supabase imports outside `src/auth`.

## Checks

```bash
cd mobile
npm install
npm run typecheck        # tsc --noEmit
npm run lint             # eslint (expo config + project rules)
npm test                 # jest (jest-expo); mocked Supabase Auth and API only
# Expo config and bundles need a valid environment:
EXPO_PUBLIC_APP_ENV=development EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000 \
EXPO_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_x \
  npx expo export --platform ios --platform android
```

**Platforms:** the alpha consumer app targets **iOS and Android only** (`platforms: ['ios', 'android']` in `app.config.ts`). Web is intentionally not a target and `react-native-web` is not installed, so a plain `npx expo export` exports the two native bundles. A web application (the future Platform Admin dashboard, or consumer web later) is a separately reviewed decision.

On a machine whose network blocks `api.expo.dev`, run Expo CLI with `EXPO_OFFLINE=1` (bundling needs no network; dependency validation is skipped). Pass placeholder values on the command line as above — never write them to `.env` files that could be committed.

## Running on a real phone

You need Node 20.19+ (22 LTS recommended), the Expo Go app from the App Store or Play Store (SDK 57), the phone and computer on the same Wi‑Fi, and a reachable API and Supabase project for the same environment.

1. **Backend.** Run the API (`cd api && npm install && npm run dev`) against a Supabase project, or use a hosted API. The phone cannot reach `localhost`:
   - on the same Wi‑Fi in development, use the computer's LAN address, for example `http://192.168.1.20:3000`, and make sure the API listens on all interfaces and the firewall allows port 3000;
   - better, use a hosted development API with HTTPS (required for staging and production).
2. **Configure.** `cp .env.example .env.local` and set the four variables. The Supabase URL and anon key must be for the same project whose JWT secret the API uses.
3. **Install and start.** `npm install`, then `npx expo start`. If the phone cannot reach Metro on the LAN, use `npx expo start --tunnel`.
4. **iPhone.** Open the Camera app, scan the QR code in the terminal, and open it in Expo Go.
5. **Android.** Open Expo Go and scan the QR code.
6. **Use it.** Sign in with an email/password user that exists in that Supabase project (the account provisioning trigger creates the Account and first Profile). With one Profile the app opens Today; with several it asks which one first.

Troubleshooting:

- "App configuration problem": a variable is missing or invalid. Fix `.env.local` and restart Expo with `npx expo start -c`.
- "You appear to be offline": the phone cannot reach the API URL. Check the LAN IP, the port and the firewall.
- Every request ends with "Your session has ended": the API is rejecting the Supabase token. Check that the API's `SUPABASE_URL` is the same project as the app's and that `SUPABASE_JWT_VERIFICATION` matches the project's signing keys (`jwks` for current projects).
- "Authentication is temporarily unavailable" / "temporarily unavailable": the API could not fetch the project's signing keys. You stay signed in; retry later.

## Expo Go or a development build

**Expo Go is the target for the alpha.** Every native module used (expo-router, expo-secure-store, expo-localization, expo-web-browser, expo-linking, expo-constants, expo-camera, react-native-safe-area-context, react-native-screens) ships in Expo Go SDK 57, and the rest is JavaScript (supabase-js, TanStack Query, zod).

- Secure storage works in Expo Go: values go to the Keychain / Keystore under Expo Go's own app identity. The placeholder bundle id, the Android backup exclusion and the app's own URL scheme only take effect in a development or store build.
- In Expo Go, the camera permission prompt is Expo Go's own. The `expo-camera` config plugin sets the app's camera-only permission text (no microphone) for development and store builds.
- In Expo Go, the OAuth redirect is an `exp://` URL, which would have to be allowed in Supabase. Google/Apple are disabled for now anyway.

**Development build:** prepared, not built. `eas.json` has `development`, `development-simulator` and `preview` profiles (no production or submit profile). The first development build also needs `npx expo install expo-dev-client`, an Expo account, EAS environment variables for the `EXPO_PUBLIC_*` values, and Apple/Google developer accounts; see `docs/40_Development_Environment.md` §8. Nothing has been built or published.

## External configuration still required

- **A Supabase project per environment** (at least development): URL and anon/publishable key for the app, and the JWT secret, URL and anon key for the API. None exists yet (`docs/37_Authentication_and_Login.md` §12).
- **A reachable API** for the phone: a LAN address in development, or a hosted HTTPS deployment. None is deployed.
- **Signing keys:** resolved in Layer 12A.1. The API verifies Supabase's asymmetric JWT signing keys through the project's JWKS (`SUPABASE_JWT_VERIFICATION=jwks`), with legacy HS256 only when explicitly configured (`docs/37_Authentication_and_Login.md` §16).
- **Google and Apple sign-in:** provider apps and credentials, Supabase provider settings and redirect URLs (the app's scheme and, for Expo Go, the `exp://` URL), then `EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS`. Apple also expects native Sign in with Apple on iOS when other social logins are offered.
- **Store identities:** real bundle ids, Apple Developer and Play Console accounts, `eas.json` and signing.
- **`DeviceSession` registration:** needs an API endpoint first.
