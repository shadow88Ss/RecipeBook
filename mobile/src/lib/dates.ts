// Calendar-day helpers for request parameters (not nutrition logic). The
// server never assumes a time zone, so the app sends the device's IANA zone.

import { getCalendars } from 'expo-localization';

export function deviceTimeZone(): string {
  try {
    const zone = getCalendars()[0]?.timeZone;
    if (zone) return zone;
  } catch {
    // fall through
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** YYYY-MM-DD of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Shifts a YYYY-MM-DD calendar date by whole days. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}
