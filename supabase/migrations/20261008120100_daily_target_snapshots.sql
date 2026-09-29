-- Phase 3 — Layer 10A (part 2 of 2): historical target context — one
-- immutable daily target snapshot per Profile + local calendar date.
--
-- Additive to effective_target_snapshot (Layer 1/4B: write-once, UPDATE
-- blocked by trigger, no UPDATE/DELETE grant). No target table, resolver
-- precedence, meal logging or Daily Tracker read path is changed here.
--
-- A `daily_tracking` snapshot:
--   * records the EffectiveTargetResolver output (canonical 7C keys, values,
--     units, field-level provenance), the resolver's unresolved fields, the
--     resolver version and resolution time — all server-computed;
--   * names the Profile-local calendar date it applies to and the IANA time
--     zone that date was taken in;
--   * can only be created for the CURRENT local date in that time zone (the
--     resolver answers "what is effective now", never "what was effective
--     then") — enforced here as well as in the API;
--   * is unique per (profile_id, local_date): the FIRST successful capture
--     freezes the day's target context (and its time zone); retries and
--     concurrent captures resolve to that one row.
-- There is no retroactive reconstruction: a date with no daily snapshot has
-- no historical target.

alter table effective_target_snapshot
  add column local_date date,
  add column local_timezone text check (local_timezone is null or char_length(local_timezone) between 1 and 64),
  add column unresolved_fields jsonb check (unresolved_fields is null or jsonb_typeof(unresolved_fields) = 'array'),
  add column created_by_account_id uuid references account (id) on delete set null,
  add constraint effective_target_snapshot_local_context_pair check ((local_date is null) = (local_timezone is null)),
  add constraint effective_target_snapshot_daily_context check (
    snapshot_reason <> 'daily_tracking'
    or (local_date is not null and local_timezone is not null and unresolved_fields is not null and linked_event_type is null)
  );

-- One historical target truth per Profile + local date.
create unique index uq_effective_target_snapshot_daily
  on effective_target_snapshot (profile_id, local_date)
  where snapshot_reason = 'daily_tracking';

create or replace function effective_target_snapshot_insert()
returns trigger
language plpgsql
as $$
declare
  v_today date;
begin
  new.created_at := now();
  new.created_by_account_id := auth.uid();
  if new.snapshot_reason = 'daily_tracking' then
    -- raises 22023 for a time zone PostgreSQL does not recognise
    v_today := (now() at time zone new.local_timezone)::date;
    if new.local_date is distinct from v_today then
      raise exception 'a daily target snapshot can only be captured for the current local date'
        using errcode = '23514', constraint = 'effective_target_snapshot_current_local_date';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_effective_target_snapshot_insert
  before insert on effective_target_snapshot
  for each row execute function effective_target_snapshot_insert();
