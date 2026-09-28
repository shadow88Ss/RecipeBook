// Layer 7B — Daily Tracker request contract. Both parameters are required:
// the tracker never assumes a server-local "today" or a global timezone
// (there is no Profile default timezone yet).

import { z } from 'zod';
import { localDateSchema, timeZoneSchema } from '../meals/meal.schemas';

export const dailyTrackerQuerySchema = z.object({
  /** The Profile-local calendar day (matches MealLog.logged_date). */
  date: localDateSchema,
  /** The caller's IANA time zone, used only to tell whether `date` is the
   * current local day (current target) or a past one. */
  timezone: timeZoneSchema,
});
export type DailyTrackerQuery = z.infer<typeof dailyTrackerQuerySchema>;
