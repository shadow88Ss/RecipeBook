// Layer 10B — progress request contract: an explicit local-date range and
// the caller's IANA time zone (never the server's). Read-only.

import { z } from 'zod';
import { localDateSchema, timeZoneSchema } from '../meals/meal.schemas';

export const MAX_PROGRESS_RANGE_DAYS = 92;

export const progressQuerySchema = z
  .object({ from: localDateSchema, to: localDateSchema, timezone: timeZoneSchema })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to.', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_PROGRESS_RANGE_DAYS, {
    message: `A progress range covers at most ${MAX_PROGRESS_RANGE_DAYS} days.`,
    path: ['to'],
  });
export type ProgressQuery = z.infer<typeof progressQuerySchema>;
