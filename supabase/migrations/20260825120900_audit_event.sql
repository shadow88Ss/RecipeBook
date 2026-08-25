-- Phase 1 — Layer 1: Database Foundation
-- AuditEvent — append-only security/audit log entry (Master §14.5, §31).

create table audit_event (
  id uuid primary key default gen_random_uuid(),
  actor_account_id uuid references account (id) on delete set null,
  actor_type audit_actor_type not null,
  event_type text not null,
  subject_type text not null,
  subject_id uuid not null,
  event_payload jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index idx_audit_event_subject on audit_event (subject_type, subject_id);
create index idx_audit_event_actor on audit_event (actor_account_id);
create index idx_audit_event_occurred_at on audit_event (occurred_at);

-- Fully immutable, append-only (Master §14.5: not user-deletable; purged only
-- per a documented log-retention schedule, out of Phase 1 scope). No legitimate
-- cascade-delete path exists for this table (actor_account_id is SET NULL, not
-- CASCADE), so both UPDATE and DELETE are blocked unconditionally here.
create trigger trg_audit_event_prevent_mutation
  before update or delete on audit_event
  for each row execute function prevent_mutation();
