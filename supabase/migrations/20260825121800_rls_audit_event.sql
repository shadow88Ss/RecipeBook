-- Phase 1 — Layer 2: Row Level Security — AuditEvent.
--
-- Per 33_Security_and_Privacy.md §4/§8: AuditEvent is "not user-deletable"
-- and read visibility is "limited/none to end user by default." AuditEvent
-- also has no profile_id column — only a generic subject_type/subject_id
-- pair, whose meaning varies by event_type (a MealItem correction, a
-- GuardianAuthorization revoke, a ClinicianTarget entry, ...). There is no
-- single, safe, generic SQL predicate that resolves "does subject_id belong
-- to a Profile the caller may access" across every possible subject_type
-- without a per-subject-type lookup — building that mapping is an API-layer
-- concern (a curated, per-feature "activity history" endpoint), not a raw
-- table-level policy.
--
-- The safe, conservative choice: no SELECT, INSERT, UPDATE, or DELETE
-- privilege is granted to `authenticated` at all. Every audit event is
-- written by trusted server/service-role code (which bypasses RLS), matching
-- "prefer trusted server/service creation for security-relevant audit
-- events." No client can create, alter, delete, or directly browse audit
-- history. This is a deliberate design choice, not an oversight — see the
-- RLS Security Report for the reasoning.

alter table audit_event enable row level security;

-- No grants, no policies for `authenticated`/`anon`. Row Level Security with
-- zero policies is default-deny for every role it applies to; combined with
-- no table-level GRANT at all, this is denied at two independent layers.
