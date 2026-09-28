// Layer 7A — consumption time semantics.
//
// consumed_at is an absolute instant (timestamptz; the request must carry an
// explicit offset or Z). logged_date is the Profile-local calendar date of
// the meal under MealLog.local_timezone, an IANA identifier — never a bare
// UTC offset, since an offset cannot express DST or answer "which local day"
// for a future Daily Tracker. There is no Profile default timezone yet
// (a later Preferences layer), so every MealLog states its own.

/** Region/City style IANA names (Asia/Dubai, America/Argentina/Buenos_Aires,
 * Etc/GMT+4) or UTC. Rejects offsets such as "+04:00" and abbreviations such
 * as "EST", which ICU may otherwise accept. */
const IANA_PATTERN = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$|^UTC$/;

/** A consumed_at this far ahead of the server clock is still accepted
 * (device clock skew); anything later is "in the future". */
export const CONSUMED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export function isValidTimeZone(timeZone: string): boolean {
  if (!IANA_PATTERN.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date (YYYY-MM-DD) of an instant in an IANA time zone. */
export function localDateOf(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    typeof instant === 'string' ? new Date(instant) : instant,
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isInFuture(instant: string, now: number = Date.now()): boolean {
  return Date.parse(instant) > now + CONSUMED_AT_FUTURE_TOLERANCE_MS;
}
