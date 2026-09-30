// Layer 12A — the /v1 endpoints the alpha app calls. Nothing here computes
// nutrition or authorization; the profile id is a path parameter and the
// server decides whether the caller may use it.

import type { ApiClient } from './client';
import { dailyTrackerSchema, type DailyTracker } from './contracts/dailyTracker';
import { profilePageSchema, type Profile, type ProfilePage } from './contracts/profile';
import { progressSchema, type Progress } from './contracts/progress';

/** Upper bound on profile pages followed; a household has far fewer. */
export const MAX_PROFILE_PAGES = 10;

export async function listAllProfiles(api: ApiClient, signal?: AbortSignal): Promise<Profile[]> {
  const out: Profile[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PROFILE_PAGES; page++) {
    const res: ProfilePage = await api.request('/v1/profiles', { query: { limit: 100, cursor }, schema: profilePageSchema, signal });
    out.push(...res.data);
    cursor = res.pagination.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export function getDailyTracker(api: ApiClient, profileId: string, date: string, timezone: string, signal?: AbortSignal): Promise<DailyTracker> {
  return api.request(`/v1/profiles/${encodeURIComponent(profileId)}/daily-tracker`, { query: { date, timezone }, schema: dailyTrackerSchema, signal });
}

export function getProgress(api: ApiClient, profileId: string, range: { from: string; to: string; timezone: string }, signal?: AbortSignal): Promise<Progress> {
  return api.request(`/v1/profiles/${encodeURIComponent(profileId)}/progress`, { query: range, schema: progressSchema, signal });
}
