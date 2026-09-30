import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { TodayScreen } from '../src/features/today/TodayScreen';
import { ProgressScreen } from '../src/features/progress/ProgressScreen';
import { ProfileSettingsScreen } from '../src/features/misc/screens';
import { invalidateAfterNutritionWrite, queryKeys } from '../src/state/queryClient';
import {
  historicalUnavailableTrackerDto,
  noConsumptionTrackerDto,
  PROFILE_A,
  PROFILE_B,
  profileDto,
  profilePage,
  progressDto,
  trackerDto,
} from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const NOW = () => new Date('2026-09-30T12:00:00Z');
const today = <TodayScreen now={NOW} timeZone="UTC" />;
const oneProfile = () => json(200, profilePage([profileDto(PROFILE_A, 'Sam')]));
const trackerRoute = (body: unknown = trackerDto()) => () => json(200, body);
const apiCalls = (calls: Call[]) => calls.filter((c) => new URL(c.url).host === 'api.test.example');

describe('auth flow and profile selection (§20, §22–23)', () => {
  it('shows the sign-in screen when no session is stored', async () => {
    await renderApp(today, { signedIn: false });
    // renderApp resolves only after auth has settled: the gate is already decided.
    expect(screen.getByTestId('sign-in-screen')).toBeTruthy();
    expect(screen.getByText('Google and Apple sign-in are not available in this build yet.')).toBeTruthy();
  });

  it('restores the session, auto-selects a single Profile and opens Today', async () => {
    const { server } = await renderApp(today, {
      routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': trackerRoute() },
    });
    expect(await screen.findByTestId('today-screen')).toBeTruthy();
    expect(screen.getByText('Sam')).toBeTruthy();
    const profilesCall = server.calls.find((c) => new URL(c.url).pathname === '/v1/profiles')!;
    expect(profilesCall.headers.authorization).toBe('Bearer access-token-1');
    expect(profilesCall.url).not.toMatch(/account/);
  });

  it('shows a selection screen for several Profiles and preserves each access scope as returned', async () => {
    await renderApp(today, {
      routes: {
        'GET /v1/profiles': () => json(200, profilePage([profileDto(PROFILE_A, 'Sam'), profileDto(PROFILE_B, 'Kid', 'pediatric_weight_management')])),
        'GET /v1/profiles/[^/]+/daily-tracker': trackerRoute(),
      },
    });
    expect(await screen.findByText('Full access')).toBeTruthy();
    expect(screen.getByText('Pediatric care access')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`select-${PROFILE_B}`));
    expect(await screen.findByTestId('tracker-view')).toBeTruthy();
    expect(screen.getByText('Kid')).toBeTruthy();
  });

  it('follows the profile pagination cursor', async () => {
    await renderApp(today, {
      routes: {
        'GET /v1/profiles': (call) =>
          new URL(call.url).searchParams.get('cursor') === 'c2'
            ? json(200, profilePage([profileDto(PROFILE_B, 'Second')]))
            : json(200, profilePage([profileDto(PROFILE_A, 'First')], 'c2')),
      },
    });
    expect(await screen.findByTestId(`profile-${PROFILE_B}`)).toBeTruthy();
    expect(screen.getByTestId(`profile-${PROFILE_A}`)).toBeTruthy();
  });

  it('asks the server for the selected Profile only; the server decides access (403 shown safely)', async () => {
    const { server } = await renderApp(today, {
      routes: {
        'GET /v1/profiles': () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', 'view_only')])),
        'GET /v1/profiles/[^/]+/daily-tracker': () => json(403, { error: { code: 'FORBIDDEN', message: 'profile_access_grant check failed', requestId: 'rq-9' } }),
      },
    });
    expect(await screen.findByText('You do not have access to this.')).toBeTruthy();
    expect(screen.getByText('Reference: rq-9')).toBeTruthy();
    expect(screen.queryByText(/profile_access_grant/)).toBeNull();
    const tracker = apiCalls(server.calls).find((c) => c.url.includes('daily-tracker'))!;
    expect(new URL(tracker.url).pathname).toBe(`/v1/profiles/${PROFILE_A}/daily-tracker`);
  });

  it('shows an empty state when the account has no Profiles', async () => {
    await renderApp(today, { routes: { 'GET /v1/profiles': () => json(200, profilePage([])) } });
    expect(await screen.findByText('There are no profiles on this account yet.')).toBeTruthy();
  });
});

describe('Today / Daily Tracker (§24–25)', () => {
  it('requests the local day with the IANA time zone and renders complete, partial and missing values', async () => {
    const { server } = await renderApp(today, { routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': trackerRoute() } });
    expect(await screen.findByTestId('tracker-view')).toBeTruthy();
    const call = apiCalls(server.calls).find((c) => c.url.includes('daily-tracker'))!;
    expect(new URL(call.url).searchParams.get('date')).toBe('2026-09-30');
    expect(new URL(call.url).searchParams.get('timezone')).toBe('UTC');

    expect(screen.getByTestId('amount-energy_kcal')).toHaveTextContent('1,234.5 kcal');
    expect(screen.getByTestId('coverage-protein_g')).toHaveTextContent('Partial: 2 of 3 items have data');
    // Missing is never zero.
    expect(screen.getByTestId('amount-carbohydrate_g')).toHaveTextContent('Not available');
    expect(screen.getByTestId('coverage-carbohydrate_g')).toHaveTextContent('No data available');
    expect(screen.getByTestId('target-context')).toHaveTextContent('Compared with your current targets');
    expect(screen.getByTestId('comparison-energy_kcal')).toHaveTextContent('765.5 kcal remaining');
    expect(screen.getByTestId('comparison-protein_g')).toHaveTextContent('At most 60 g remaining (some items have no data)');
    expect(screen.getByTestId('comparison-fat_g')).toHaveTextContent('No target set');
  });

  it('shows known zeros for a day with no consumption', async () => {
    await renderApp(today, { routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': trackerRoute(noConsumptionTrackerDto()) } });
    expect(await screen.findByTestId('no-consumption')).toBeTruthy();
    expect(screen.getByTestId('amount-energy_kcal')).toHaveTextContent('0 kcal');
    expect(screen.getByTestId('coverage-fiber_g')).toHaveTextContent('Complete');
  });

  it('keeps the historical-target-unavailable context and shows no comparison', async () => {
    await renderApp(today, { routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': trackerRoute(historicalUnavailableTrackerDto()) } });
    expect(await screen.findByTestId('target-context')).toHaveTextContent('Targets for this day were not saved, so there is no comparison.');
    expect(screen.queryByTestId('comparison-energy_kcal')).toBeNull();
  });

  it('labels a saved daily snapshot target as such', async () => {
    const body = trackerDto({ target: { ...trackerDto().target, status: 'daily_snapshot', context: 'daily_snapshot', daily_snapshot: { id: 's', local_date: '2026-09-30', local_timezone: 'UTC', snapshot_reason: 'daily_tracking', captured_at: '2026-09-30T06:00:00Z' } } });
    await renderApp(today, { routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': trackerRoute(body) } });
    expect(await screen.findByTestId('target-context')).toHaveTextContent('Compared with the targets saved for this day');
  });

  it('moves to the previous day and cannot go past today', async () => {
    const { server } = await renderApp(today, { routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': trackerRoute() } });
    await screen.findByTestId('tracker-view');
    expect(screen.getByTestId('next-day')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('previous-day'));
    expect(screen.getByTestId('tracker-date')).toHaveTextContent('2026-09-29');
    await waitFor(() => expect(apiCalls(server.calls).some((c) => c.url.includes('date=2026-09-29'))).toBe(true));
  });

  it('shows an offline state with retry when the network is unavailable', async () => {
    let fail = true;
    await renderApp(today, {
      routes: {
        'GET /v1/profiles': oneProfile,
        'GET /v1/profiles/[^/]+/daily-tracker': () => {
          if (fail) throw new TypeError('Network request failed');
          return json(200, trackerDto());
        },
      },
    });
    expect(await screen.findByText('You appear to be offline. Check your connection.')).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByTestId('tracker-view')).toBeTruthy();
  });

  it('shows a safe server-error state (no stack trace or SQL)', async () => {
    await renderApp(today, {
      routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': () => json(500, { error: { code: 'INTERNAL_ERROR', message: 'syntax error at or near SELECT', requestId: 'r5' } }) },
    });
    expect(await screen.findByText('Something went wrong on our side.')).toBeTruthy();
    expect(screen.queryByText(/SELECT/)).toBeNull();
  });

  it('on an API 401 clears the secure session and returns to sign-in with a notice', async () => {
    const { store } = await renderApp(today, {
      routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r' } }), 'POST /auth/v1/logout': () => new Response(null, { status: 204 }) },
    });
    expect(await screen.findByTestId('session-expired')).toHaveTextContent('Your session has ended. Please sign in again.');
    expect(screen.getByTestId('sign-in-screen')).toBeTruthy();
    expect(store.data.size).toBe(0);
  });

  it.each([
    [503, 'This service is temporarily unavailable.'],
    [500, 'Something went wrong on our side.'],
  ])('keeps the session on an API %i (outage is not an auth failure)', async (status, message) => {
    const { store } = await renderApp(today, {
      routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/daily-tracker': () => json(status, { error: { code: 'X', message: 'Authentication is temporarily unavailable.', requestId: 'r' } }) },
    });
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByTestId('sign-in-screen')).toBeNull();
    expect(store.data.size).toBeGreaterThan(0);
  });

  it('keeps the session when the API is unreachable', async () => {
    const { store } = await renderApp(today, {
      routes: {
        'GET /v1/profiles': () => {
          throw new TypeError('Network request failed');
        },
      },
    });
    expect(await screen.findByText('You appear to be offline. Check your connection.')).toBeTruthy();
    expect(screen.getByTestId('select-profile-screen')).toBeTruthy();
    expect(store.data.size).toBeGreaterThan(0);
  });

  it('invalidateAfterNutritionWrite re-reads the Daily Tracker for that Profile', async () => {
    let served = 0;
    const { queryClient } = await renderApp(today, {
      routes: {
        'GET /v1/profiles': oneProfile,
        'GET /v1/profiles/[^/]+/daily-tracker': () => {
          served += 1;
          return json(200, trackerDto());
        },
      },
    });
    await screen.findByTestId('tracker-view');
    expect(served).toBe(1);
    await act(() => invalidateAfterNutritionWrite(queryClient, PROFILE_A));
    await waitFor(() => expect(served).toBe(2));
    expect(queryClient.getQueryState(queryKeys.dailyTracker(PROFILE_A, '2026-09-30', 'UTC'))?.status).toBe('success');
  });
});

describe('Progress (§26)', () => {
  it('shows the three sections factually with no combined score', async () => {
    const { server } = await renderApp(<ProgressScreen now={NOW} timeZone="UTC" />, {
      routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/progress': () => json(200, progressDto()) },
    });
    expect(await screen.findByTestId('progress-plan')).toBeTruthy();
    const call = apiCalls(server.calls).find((c) => c.url.includes('/progress'))!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ from: '2026-09-24', to: '2026-09-30', timezone: 'UTC' });
    expect(screen.getByTestId('rate-exact_fulfillment_rate')).toHaveTextContent('Eaten as planned: 4 of 8 (50%)');
    expect(screen.getByTestId('adherence-energy')).toHaveTextContent('Energy: 3 of 4 days comparable. Average 90% of target (comparable days only)');
    expect(screen.getByTestId('adherence-fiber')).toHaveTextContent('Fiber: 0 of 4 days comparable. No comparable days');
    expect(screen.getByTestId('weight-latest')).toHaveTextContent('Latest: 79.9 kg on 2026-09-30');
    expect(screen.getByTestId('weight-change')).toHaveTextContent('Change: -0.5 kg');
    expect(screen.queryByText(/score/i)).toBeNull();
  });

  it('shows "no eligible planned items" and "no measurements" instead of zeros', async () => {
    const base = progressDto();
    const nullRate = { count: 0, denominator: 0, percentage: null };
    const body = progressDto({
      plan_fulfillment: { ...base.plan_fulfillment, rates: { ...base.plan_fulfillment.rates, status: 'no_eligible_planned_items', denominator: { name: 'x', value: 0 }, exact_fulfillment_rate: nullRate } },
      goal_progress: { ...base.goal_progress, first_active: null, latest_active: null, absolute_change_kg: null, goals: [] },
    });
    await renderApp(<ProgressScreen now={NOW} timeZone="UTC" />, { routes: { 'GET /v1/profiles': oneProfile, 'GET /v1/profiles/[^/]+/progress': () => json(200, body) } });
    expect(await screen.findByTestId('plan-none')).toBeTruthy();
    expect(screen.getByTestId('weight-none')).toBeTruthy();
  });
});

describe('Profile & settings (§20, §41 D)', () => {
  it('sign-out clears the secure session and the cached server data', async () => {
    const { store, queryClient } = await renderApp(<ProfileSettingsScreen />, {
      routes: { 'GET /v1/profiles': oneProfile, 'POST /auth/v1/logout': () => new Response(null, { status: 204 }) },
    });
    expect(await screen.findByTestId('current-scope')).toHaveTextContent('Full access');
    expect(store.data.size).toBeGreaterThan(0);
    await fireEvent.press(screen.getByTestId('sign-out'));
    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy();
    expect(store.data.size).toBe(0);
    // Only the idle, signed-out profiles observer remains; no server data is kept.
    expect(queryClient.getQueryCache().getAll().every((q) => q.state.data === undefined)).toBe(true);
  });

  it('signs in with email and password from the sign-in screen', async () => {
    const { server } = await renderApp(today, {
      signedIn: false,
      routes: {
        'POST /auth/v1/token': () =>
          json(200, {
            access_token: 'new-token',
            refresh_token: 'r',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
          }),
        'GET /v1/profiles': oneProfile,
        'GET /v1/profiles/[^/]+/daily-tracker': trackerRoute(),
      },
    });
    await screen.findByTestId('sign-in-screen');
    await fireEvent.press(screen.getByTestId('sign-in-submit'));
    expect(screen.getByTestId('sign-in-error')).toHaveTextContent('Enter your email and password.');
    await fireEvent.changeText(screen.getByTestId('email-input'), 'owner@example.test');
    await fireEvent.changeText(screen.getByTestId('password-input'), 'pw');
    await fireEvent.press(screen.getByTestId('sign-in-submit'));
    expect(await screen.findByTestId('today-screen')).toBeTruthy();
    const call = apiCalls(server.calls)[0]!;
    expect(call.headers.authorization).toBe('Bearer new-token');
  });
});
