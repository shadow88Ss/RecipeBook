-- Layer 13A — website recipe import: recording an import and saving its
-- recipe with provenance.
--
-- Additive. No existing table is redefined, no RLS policy is broadened and
-- no grant is widened. The Layer 1 import tables (url_source, import_job,
-- raw_content, ai_extraction; 20260825120500) and their Layer 2 policies
-- (20260825121400) stay as they are: url_source has no client access at
-- all, and raw_content / ai_extraction are never client-writable. The API
-- runs as the calling user (no service-role credential, env.ts), so the
-- trusted writes those tables require go through the narrow SECURITY
-- DEFINER functions below, each of which acts only on the caller's own
-- import job.
--
-- Trust boundary. These functions are reachable by any authenticated
-- token, not only through the API, so a caller could submit their own
-- extraction for their own job. That only ever affects the caller's own
-- import and the recipe they save from it: an extraction is never shared
-- with or reused for another account, and url_source keeps only the
-- canonical URL, first-seen original URL and timestamps.
--
-- 1. raw_content.content_excerpt: the bounded structured data the extractor
--    read (the page's schema.org Recipe node), not the whole page
--    (Master §14.4: provenance, not an archive). storage_reference is
--    'inline:content_excerpt' for these rows.
-- 2. begin_url_recipe_import(): UrlSource upsert by canonical URL + a new
--    ImportJob (or the same job again for a repeated idempotency key).
-- 3. complete_url_recipe_import(): records RawContent + AiExtraction and
--    the job outcome, once, for a job still `processing`.
-- 4. url_recipe_import_source(): the source URL of the caller's own job.
-- 5. recipe_version origin integrity: origin_* may only point at an import
--    of the same Profile that produced an extraction. Before this, a client
--    could insert a version claiming any import as its origin.
-- 6. claim_url_import_for_save() + create_recipe_version() reading an
--    optional `origin`: saving marks the job `succeeded` and writes the
--    recipe in one transaction; a second save of the same import, or a
--    second recipe in the Profile from the same source, is refused.

-- ------------------------------------------------------------------
-- 1. raw_content.content_excerpt
-- ------------------------------------------------------------------
alter table raw_content
  add column content_excerpt jsonb,
  add constraint raw_content_excerpt_bounded
    check (content_excerpt is null or octet_length(content_excerpt::text) <= 1000000);

alter table ai_extraction
  add constraint ai_extraction_payload_bounded
    check (octet_length(extracted_payload::text) <= 1000000);

create index idx_import_job_requested_profile_source
  on import_job (requested_by_profile_id, url_source_id);

create index idx_recipe_version_origin_url_source
  on recipe_version (origin_url_source_id) where origin_url_source_id is not null;

-- ------------------------------------------------------------------
-- 2. begin_url_recipe_import()
-- ------------------------------------------------------------------
-- The canonical URL is computed by the API (sourceUrl.ts); it is checked
-- here for shape only. The idempotency key is namespaced by Account so one
-- caller's keys can never collide with, or reveal, another's.
create or replace function begin_url_recipe_import(
  p_profile_id uuid,
  p_original_url text,
  p_canonical_url text,
  p_provider url_source_provider,
  p_idempotency_key text,
  p_extractor_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_source_id uuid;
  v_job import_job%rowtype;
  v_trigger import_trigger_type;
begin
  if v_uid is null or profile_access_scope(p_profile_id) is distinct from 'full_management' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_canonical_url is null or length(p_canonical_url) > 2048 or p_canonical_url !~ '^https?://[a-z0-9.-]+(/|\?|$)'
     or p_original_url is null or length(p_original_url) > 2048 or p_original_url !~* '^https?://' then
    raise exception 'invalid source url' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 200
     or p_extractor_version is null or length(p_extractor_version) not between 1 and 100 then
    raise exception 'invalid import request' using errcode = '22023';
  end if;
  v_key := v_uid::text || ':' || p_idempotency_key;

  select * into v_job from import_job where idempotency_key = v_key;
  if found then
    if v_job.requested_by_profile_id is distinct from p_profile_id
       or not exists (select 1 from url_source us where us.id = v_job.url_source_id and us.canonical_url = p_canonical_url) then
      raise exception 'idempotency key reused for a different import' using errcode = '23505';
    end if;
    return jsonb_build_object('import_job_id', v_job.id, 'url_source_id', v_job.url_source_id, 'replayed', true,
                              'processing_status', v_job.processing_status);
  end if;

  insert into url_source (canonical_url, original_url, source_provider)
  values (p_canonical_url, p_original_url, p_provider)
  on conflict (canonical_url) do update set last_checked_at = now()
  returning id into v_source_id;

  v_trigger := case
    when exists (select 1 from import_job ij where ij.url_source_id = v_source_id and ij.requested_by_profile_id = p_profile_id)
      then 'manual_reimport'::import_trigger_type
    else 'initial_import'::import_trigger_type
  end;

  insert into import_job (url_source_id, idempotency_key, trigger_type, requested_by_account_id, requested_by_profile_id,
                          extraction_model_version, processing_status, started_at)
  values (v_source_id, v_key, v_trigger, v_uid, p_profile_id, p_extractor_version, 'processing', now())
  returning * into v_job;

  return jsonb_build_object('import_job_id', v_job.id, 'url_source_id', v_source_id, 'replayed', false,
                            'processing_status', v_job.processing_status);
end;
$$;

revoke all on function begin_url_recipe_import(uuid, text, text, url_source_provider, text, text) from public;
grant execute on function begin_url_recipe_import(uuid, text, text, url_source_provider, text, text) to authenticated;

-- ------------------------------------------------------------------
-- 3. complete_url_recipe_import()
-- ------------------------------------------------------------------
-- p_outcome:
--   { status: 'needs_confirmation' | 'retryable_failed' | 'permanently_failed',
--     error_code: text (required unless needs_confirmation),
--     content_fingerprint: text,
--     raw: { fetched_at, excerpt } (required for needs_confirmation),
--     extraction: { method, model_version, confidence, status, payload }
--                 (required for needs_confirmation) }
create or replace function complete_url_recipe_import(p_import_job_id uuid, p_outcome jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_job import_job%rowtype;
  v_status import_processing_status := (p_outcome->>'status')::import_processing_status;
  v_raw_id uuid;
  v_extraction_id uuid;
begin
  select * into v_job from import_job where id = p_import_job_id for update;
  if not found or v_uid is null or v_job.requested_by_account_id is distinct from v_uid then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if v_job.processing_status <> 'processing' then
    raise exception 'import already completed' using errcode = '55000';
  end if;
  if v_status not in ('needs_confirmation', 'retryable_failed', 'permanently_failed') then
    raise exception 'invalid outcome status' using errcode = '22023';
  end if;
  if v_status <> 'needs_confirmation' and coalesce(length(p_outcome->>'error_code'), 0) not between 1 and 100 then
    raise exception 'error_code required' using errcode = '22023';
  end if;

  if v_status = 'needs_confirmation' then
    if jsonb_typeof(p_outcome->'raw'->'excerpt') is null or jsonb_typeof(p_outcome->'extraction'->'payload') <> 'object' then
      raise exception 'raw content and extraction required' using errcode = '22023';
    end if;
    v_raw_id := gen_random_uuid();
    insert into raw_content (id, import_job_id, url_source_id, content_type, storage_reference, fetched_at, content_excerpt)
    values (v_raw_id, v_job.id, v_job.url_source_id, 'json', 'inline:content_excerpt',
            coalesce((p_outcome->'raw'->>'fetched_at')::timestamptz, now()), p_outcome->'raw'->'excerpt');
    v_extraction_id := gen_random_uuid();
    insert into ai_extraction (id, raw_content_id, import_job_id, source, extraction_method, model_version, confidence, status, extracted_payload)
    values (v_extraction_id, v_raw_id, v_job.id, 'url_import',
            p_outcome->'extraction'->>'method',
            p_outcome->'extraction'->>'model_version',
            (p_outcome->'extraction'->>'confidence')::numeric,
            (p_outcome->'extraction'->>'status')::ai_extraction_status,
            p_outcome->'extraction'->'payload');
  end if;

  update import_job
     set processing_status = v_status,
         error_code = case when v_status = 'needs_confirmation' then null else p_outcome->>'error_code' end,
         content_fingerprint = p_outcome->>'content_fingerprint',
         completed_at = now()
   where id = v_job.id;

  update url_source
     set last_checked_at = now(),
         latest_content_fingerprint = coalesce(p_outcome->>'content_fingerprint', latest_content_fingerprint)
   where id = v_job.url_source_id;

  return jsonb_build_object('import_job_id', v_job.id, 'processing_status', v_status, 'ai_extraction_id', v_extraction_id);
end;
$$;

revoke all on function complete_url_recipe_import(uuid, jsonb) from public;
grant execute on function complete_url_recipe_import(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------
-- 4. url_recipe_import_source()
-- ------------------------------------------------------------------
create or replace function url_recipe_import_source(p_import_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('canonical_url', us.canonical_url, 'original_url', us.original_url, 'provider', us.source_provider)
    from import_job ij
    join url_source us on us.id = ij.url_source_id
   where ij.id = p_import_job_id
     and ij.requested_by_account_id = auth.uid();
$$;

revoke all on function url_recipe_import_source(uuid) from public;
grant execute on function url_recipe_import_source(uuid) to authenticated;

-- ------------------------------------------------------------------
-- 5. recipe_version origin integrity
-- ------------------------------------------------------------------
-- A version may name an import as its origin only if that import was made
-- for the recipe's own Profile and produced an extraction. The url_source is
-- taken from the job (filled when omitted, refused when it disagrees), and
-- an ai_extraction must belong to the job. Carrying the origin into later
-- versions of the same recipe (any manager of the Profile) stays valid.
create or replace function recipe_version_origin_valid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job import_job%rowtype;
  v_profile uuid;
begin
  if new.origin_import_job_id is null then
    if new.origin_url_source_id is not null or new.origin_ai_extraction_id is not null then
      raise exception 'origin requires origin_import_job_id' using errcode = '23514', constraint = 'recipe_version_origin_valid';
    end if;
    return new;
  end if;
  select * into v_job from import_job where id = new.origin_import_job_id;
  select r.created_by_profile_id into v_profile from recipe r where r.id = new.recipe_id;
  if not found or v_job.id is null or v_job.requested_by_profile_id is distinct from v_profile
     or v_job.processing_status not in ('needs_confirmation', 'succeeded')
     or (new.origin_url_source_id is not null and new.origin_url_source_id is distinct from v_job.url_source_id)
     or (new.origin_ai_extraction_id is not null and not exists (
           select 1 from ai_extraction ae where ae.id = new.origin_ai_extraction_id and ae.import_job_id = v_job.id))
     or not exists (select 1 from ai_extraction ae where ae.import_job_id = v_job.id) then
    raise exception 'invalid recipe origin' using errcode = '23514', constraint = 'recipe_version_origin_valid';
  end if;
  new.origin_url_source_id := v_job.url_source_id;
  return new;
end;
$$;

revoke all on function recipe_version_origin_valid() from public;

create trigger trg_recipe_version_origin_valid
  before insert on recipe_version
  for each row execute function recipe_version_origin_valid();

-- ------------------------------------------------------------------
-- 6. Saving an import
-- ------------------------------------------------------------------
-- claim_url_import_for_save(): locks the caller's job, checks it is ready
-- (`needs_confirmation`) and that the Profile has no recipe from this source
-- yet, and marks it `succeeded`. Called by save_url_import_recipe() in the
-- same transaction as the recipe write, so a failed write leaves the job
-- unclaimed.
create or replace function claim_url_import_for_save(p_profile_id uuid, p_import_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_job import_job%rowtype;
  v_extraction_id uuid;
  v_existing uuid;
begin
  if v_uid is null or profile_access_scope(p_profile_id) is distinct from 'full_management' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_job from import_job where id = p_import_job_id for update;
  if not found or v_job.requested_by_account_id is distinct from v_uid or v_job.requested_by_profile_id is distinct from p_profile_id then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  -- Serializes saves from different imports of the same source too.
  perform 1 from url_source where id = v_job.url_source_id for update;
  select r.id into v_existing
    from recipe r
    join recipe_version rv on rv.recipe_id = r.id
   where r.created_by_profile_id = p_profile_id
     and rv.origin_url_source_id = v_job.url_source_id
   limit 1;
  if v_existing is not null then
    raise exception 'recipe already imported: %', v_existing using errcode = '23505', detail = v_existing::text;
  end if;
  if v_job.processing_status <> 'needs_confirmation' then
    raise exception 'import is not ready to save' using errcode = '55000';
  end if;
  select ae.id into v_extraction_id from ai_extraction ae where ae.import_job_id = v_job.id order by ae.created_at desc limit 1;
  if v_extraction_id is null then
    raise exception 'import is not ready to save' using errcode = '55000';
  end if;
  update import_job set processing_status = 'succeeded' where id = v_job.id;
  return jsonb_build_object('import_job_id', v_job.id, 'url_source_id', v_job.url_source_id, 'ai_extraction_id', v_extraction_id);
end;
$$;

revoke all on function claim_url_import_for_save(uuid, uuid) from public;
grant execute on function claim_url_import_for_save(uuid, uuid) to authenticated;

-- create_recipe_version(): unchanged except that p_content may carry
-- `origin: { import_job_id, url_source_id, ai_extraction_id }`, written to
-- the version's origin_* columns (validated by trigger 5).
create or replace function create_recipe_version(
  p_profile_id uuid,
  p_recipe_id uuid,
  p_expected_current_version_id uuid,
  p_content jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_recipe_id uuid := p_recipe_id;
  v_version_id uuid := gen_random_uuid();
  v_current uuid;
  v_profile uuid;
  v_number integer;
  v_ingredient jsonb;
  v_position integer := 0;
  v_step text;
begin
  if v_recipe_id is null then
    v_recipe_id := gen_random_uuid();
    insert into recipe (id, canonical_title, created_by_account_id, created_by_profile_id, visibility)
    values (v_recipe_id, p_content->>'title', auth.uid(), p_profile_id, 'private');
    v_number := 1;
  else
    select r.current_version_id, r.created_by_profile_id
      into v_current, v_profile
      from recipe r
     where r.id = v_recipe_id
       for update;
    if not found or v_profile is distinct from p_profile_id then
      raise exception 'recipe not found' using errcode = 'P0002';
    end if;
    if p_expected_current_version_id is not null and v_current is distinct from p_expected_current_version_id then
      raise exception 'recipe has a newer current version' using errcode = '40001';
    end if;
    select coalesce(max(rv.version_number), 0) + 1 into v_number from recipe_version rv where rv.recipe_id = v_recipe_id;
  end if;

  insert into recipe_version (id, recipe_id, version_number, title, description, servings, created_by_account_id,
                              origin_url_source_id, origin_import_job_id, origin_ai_extraction_id)
  values (
    v_version_id,
    v_recipe_id,
    v_number,
    p_content->>'title',
    p_content->>'description',
    (p_content->>'servings')::numeric,
    auth.uid(),
    (p_content->'origin'->>'url_source_id')::uuid,
    (p_content->'origin'->>'import_job_id')::uuid,
    (p_content->'origin'->>'ai_extraction_id')::uuid
  );

  for v_ingredient in select value from jsonb_array_elements(coalesce(p_content->'ingredients', '[]'::jsonb)) loop
    v_position := v_position + 1;
    insert into recipe_ingredient
      (recipe_version_id, food_id, food_serving_id, raw_ingredient_text, quantity, unit, match_confidence, match_status, sort_order)
    values (
      v_version_id,
      (v_ingredient->>'food_id')::uuid,
      (v_ingredient->>'food_serving_id')::uuid,
      v_ingredient->>'raw_ingredient_text',
      (v_ingredient->>'quantity')::numeric,
      v_ingredient->>'unit',
      (v_ingredient->>'match_confidence')::numeric,
      (v_ingredient->>'match_status')::recipe_ingredient_match_status,
      v_position
    );
  end loop;

  v_position := 0;
  for v_step in select value from jsonb_array_elements_text(coalesce(p_content->'instructions', '[]'::jsonb)) loop
    v_position := v_position + 1;
    insert into recipe_instruction (recipe_version_id, step_number, instruction_text)
    values (v_version_id, v_position, v_step);
  end loop;

  update recipe
     set current_version_id = v_version_id,
         canonical_title = p_content->>'title'
   where id = v_recipe_id;

  return jsonb_build_object('recipe_id', v_recipe_id, 'recipe_version_id', v_version_id, 'version_number', v_number);
end;
$$;

-- save_url_import_recipe(): claim + write, one transaction. SECURITY
-- INVOKER: the recipe write runs as the caller under the Recipe-family RLS
-- exactly like a normal create; only the claim step is definer.
create or replace function save_url_import_recipe(p_profile_id uuid, p_import_job_id uuid, p_content jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_claim jsonb;
begin
  v_claim := claim_url_import_for_save(p_profile_id, p_import_job_id);
  return create_recipe_version(
    p_profile_id, null, null,
    p_content || jsonb_build_object('origin', jsonb_build_object(
      'import_job_id', v_claim->>'import_job_id',
      'url_source_id', v_claim->>'url_source_id',
      'ai_extraction_id', v_claim->>'ai_extraction_id'))
  );
end;
$$;

revoke all on function save_url_import_recipe(uuid, uuid, jsonb) from public;
grant execute on function save_url_import_recipe(uuid, uuid, jsonb) to authenticated;
