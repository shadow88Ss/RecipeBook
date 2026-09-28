// Layer 4B §7/§8 — EffectiveTargetResolver response contract
// (29_Data_Model.md §4.1; Layer 4B spec §8's worked example, which keys the
// resolved map by field_name — "protein: value: ... source: ...").
//
// Phase 1 implements only 2 of the 4 precedence levels in Master §8.1
// (clinician_target, user_target) — mandatory safety/clinical constraints
// and profile-derived/default targets belong to the not-yet-built
// Nutrition Engine (Phase 2) and are never fabricated here (Layer 4B spec
// §7: "DO NOT invent nutrition formulas"). `implemented_sources` makes this
// contractually explicit rather than leaving a client to assume a field's
// absence means "no data" instead of "not yet resolvable by this phase".

import { z } from 'zod';

export const resolvedFieldSourceSchema = z.enum(['safety_rule', 'clinician_target', 'user_target', 'profile_derived']);

export const resolvedFieldSchema = z.object({
  value: z.number(),
  unit: z.string(),
  source: resolvedFieldSourceSchema,
  source_reference: z.uuid(),
});
export type ResolvedField = z.infer<typeof resolvedFieldSchema>;

/** Layer 7C — an active target row the resolver could not use, and why. */
export const unresolvedTargetFieldSchema = z.object({
  field_name: z.string(),
  source: z.enum(['clinician_target', 'user_target']),
  source_reference: z.uuid(),
  reason: z.enum(['unknown_target_key', 'incompatible_unit', 'invalid_value', 'conflicting_rows']),
});
export type UnresolvedTargetField = z.infer<typeof unresolvedTargetFieldSchema>;

export const effectiveTargetResponseSchema = z.object({
  profile_id: z.uuid(),
  /** Keyed by canonical target key (Layer 7C), values in its reporting unit. */
  resolved: z.record(z.string(), resolvedFieldSchema),
  unresolved_fields: z.array(unresolvedTargetFieldSchema),
  resolver_version: z.string(),
  resolved_at: z.iso.datetime({ offset: true }),
  implemented_sources: z.array(resolvedFieldSourceSchema),
});
export type EffectiveTargetResponse = z.infer<typeof effectiveTargetResponseSchema>;

export const snapshotDtoSchema = z.object({
  id: z.uuid(),
  profile_id: z.uuid(),
  snapshot_payload: z.record(z.string(), resolvedFieldSchema),
  resolver_version: z.string(),
  resolved_at: z.iso.datetime({ offset: true }),
  snapshot_reason: z.enum([
    'meal_consumed',
    'daily_summary_finalized',
    'coach_recommendation_issued',
    'user_requested_export',
    'manual_audit',
  ]),
  linked_event_type: z.enum(['consumed_meal', 'daily_summary_finalized', 'coach_recommendation', 'other_auditable_decision']).nullable(),
  linked_event_id: z.uuid().nullable(),
  created_at: z.iso.datetime({ offset: true }),
});
export type SnapshotDto = z.infer<typeof snapshotDtoSchema>;
