-- Phase 1 — Layer 1: Database Foundation
-- UrlSource, ImportJob, RawContent, AiExtraction.
-- Approved architecture (29_Data_Model.md §7): UrlSource and ImportJob are
-- permanently separate entities. UrlSource 1 -> N ImportJob. Do not merge.

create table url_source (
  id uuid primary key default gen_random_uuid(),
  canonical_url text not null unique,
  original_url text not null,
  source_provider url_source_provider not null,
  first_seen_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  latest_content_fingerprint text,
  created_at timestamptz not null default now()
);

create table import_job (
  id uuid primary key default gen_random_uuid(),
  url_source_id uuid not null references url_source (id) on delete cascade,
  idempotency_key text not null unique,
  trigger_type import_trigger_type not null,
  requested_by_account_id uuid references account (id) on delete set null,
  requested_by_profile_id uuid references profile (id) on delete set null,
  content_fingerprint text,
  extraction_model_version text,
  processing_status import_processing_status not null default 'queued',
  retry_count integer not null default 0 check (retry_count >= 0),
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- requested_by_* is null only for a system-scheduled recheck (29_Data_Model_Data_Dictionary.md §25).
  constraint import_job_requester_required_unless_scheduled
    check (
      trigger_type = 'scheduled_recheck'
      or (requested_by_account_id is not null and requested_by_profile_id is not null)
    )
);

create index idx_import_job_url_source_created on import_job (url_source_id, created_at);

create trigger trg_import_job_set_updated_at
  before update on import_job
  for each row execute function set_updated_at();

create table raw_content (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null references import_job (id) on delete cascade,
  url_source_id uuid not null references url_source (id) on delete cascade,
  content_type raw_content_type not null,
  storage_reference text not null,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index idx_raw_content_import_job_id on raw_content (import_job_id);

-- Denormalized url_source_id must match the parent ImportJob's url_source_id
-- (29_Data_Model_Data_Dictionary.md §26) — a cross-row invariant, enforced here
-- rather than left to the application layer.
create function enforce_raw_content_url_source_matches_import_job()
returns trigger
language plpgsql
as $$
declare
  job_url_source_id uuid;
begin
  select url_source_id into job_url_source_id from import_job where id = new.import_job_id;
  if job_url_source_id is distinct from new.url_source_id then
    raise exception 'raw_content.url_source_id must match import_job.url_source_id for import_job_id %', new.import_job_id;
  end if;
  return new;
end;
$$;

create trigger trg_raw_content_url_source_check
  before insert or update on raw_content
  for each row execute function enforce_raw_content_url_source_matches_import_job();

-- Immutable: a new ImportJob attempt produces a new row, never an in-place overwrite.
create trigger trg_raw_content_prevent_update
  before update on raw_content
  for each row execute function prevent_update();

create table ai_extraction (
  id uuid primary key default gen_random_uuid(),
  raw_content_id uuid not null references raw_content (id) on delete cascade,
  import_job_id uuid not null references import_job (id) on delete cascade,
  source ai_extraction_source not null,
  extraction_method text not null,
  model_version text not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  status ai_extraction_status not null,
  extracted_payload jsonb not null,
  created_at timestamptz not null default now()
);

create index idx_ai_extraction_raw_content_id on ai_extraction (raw_content_id);

-- Denormalized import_job_id must match the parent RawContent's import_job_id
-- (29_Data_Model_Data_Dictionary.md §27, §7.4 traceability).
create function enforce_ai_extraction_import_job_matches_raw_content()
returns trigger
language plpgsql
as $$
declare
  content_import_job_id uuid;
begin
  select import_job_id into content_import_job_id from raw_content where id = new.raw_content_id;
  if content_import_job_id is distinct from new.import_job_id then
    raise exception 'ai_extraction.import_job_id must match raw_content.import_job_id for raw_content_id %', new.raw_content_id;
  end if;
  return new;
end;
$$;

create trigger trg_ai_extraction_import_job_check
  before insert or update on ai_extraction
  for each row execute function enforce_ai_extraction_import_job_matches_raw_content();

-- Immutable: a re-run produces a new row, never an in-place overwrite.
create trigger trg_ai_extraction_prevent_update
  before update on ai_extraction
  for each row execute function prevent_update();
