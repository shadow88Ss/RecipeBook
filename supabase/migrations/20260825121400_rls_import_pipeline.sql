-- Phase 1 — Layer 2: Row Level Security — UrlSource, ImportJob, RawContent,
-- AiExtraction.
--
-- Per 33_Security_and_Privacy.md §8: UrlSource is "read/write restricted to
-- the service layer; not directly client-writable" — meaning no direct
-- client access at all, read or write. ImportJob is "RW restricted to the
-- initiating Account for visibility/retry actions; processing_status written
-- by system/worker only." RawContent/AiExtraction are "read restricted to
-- initiating Account + trusted service; never client-writable directly."

-- ============================================================
-- url_source
-- ============================================================
alter table url_source enable row level security;

-- Deliberately NO grants and NO policies for `authenticated` at all. A
-- client never queries url_source directly; any user-facing display of a
-- source URL is composed server-side (service_role, which bypasses RLS) and
-- returned as part of an API response, not read from this table directly.

-- ============================================================
-- import_job
-- ============================================================
alter table import_job enable row level security;

-- No UPDATE grant: processing_status, retry_count, error_code, timestamps
-- are system/worker-written only. A client triggers a new import by
-- INSERTing a new ImportJob (e.g. trigger_type = 'retry'/'manual_reimport'),
-- never by updating an existing job's status.
grant select, insert on import_job to authenticated;

create policy import_job_select_own on import_job
  for select to authenticated
  using (requested_by_account_id = auth.uid());

create policy import_job_insert_own on import_job
  for insert to authenticated
  with check (
    requested_by_account_id = auth.uid()
    and profile_access_scope(requested_by_profile_id) = 'full_management'
  );

-- ============================================================
-- raw_content
-- ============================================================
alter table raw_content enable row level security;

-- No INSERT/UPDATE/DELETE grant: raw content is written only by the
-- ingestion/worker pipeline (service_role), never directly by a client.
grant select on raw_content to authenticated;

create policy raw_content_select_own on raw_content
  for select to authenticated
  using (
    exists (
      select 1 from import_job ij
      where ij.id = raw_content.import_job_id
        and ij.requested_by_account_id = auth.uid()
    )
  );

-- ============================================================
-- ai_extraction
-- ============================================================
alter table ai_extraction enable row level security;

-- No INSERT/UPDATE/DELETE grant: AI extraction rows are written only by the
-- AI pipeline (service_role), never directly by a client.
grant select on ai_extraction to authenticated;

create policy ai_extraction_select_own on ai_extraction
  for select to authenticated
  using (
    exists (
      select 1 from import_job ij
      where ij.id = ai_extraction.import_job_id
        and ij.requested_by_account_id = auth.uid()
    )
  );
