-- Phase 1 — Layer 1: Database Foundation
-- WearableConnection, Activity, Workout, Sleep, Recovery.
-- Master §17: every sync supports provider identity, source record identity,
-- idempotent upsert, sync cursor/checkpoint, provenance, retry/failure handling.

create table wearable_connection (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  provider wearable_provider not null,
  provider_account_reference text not null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  sync_cursor text,
  last_sync_status wearable_sync_status,
  retry_count integer not null default 0 check (retry_count >= 0),
  created_at timestamptz not null default now(),
  unique (profile_id, provider)
);

create index idx_wearable_connection_profile_id on wearable_connection (profile_id);

create table activity (
  id uuid primary key default gen_random_uuid(),
  wearable_connection_id uuid not null references wearable_connection (id) on delete cascade,
  profile_id uuid not null references profile (id) on delete cascade,
  provider_record_id text not null,
  recorded_at timestamptz not null,
  provenance wearable_measurement_provenance not null,
  synced_at timestamptz not null,
  activity_type text not null,
  duration_minutes numeric not null check (duration_minutes > 0),
  energy_kcal numeric check (energy_kcal is null or energy_kcal >= 0),
  created_at timestamptz not null default now(),
  unique (wearable_connection_id, provider_record_id)
);

create index idx_activity_profile_id on activity (profile_id, recorded_at);

create table workout (
  id uuid primary key default gen_random_uuid(),
  wearable_connection_id uuid not null references wearable_connection (id) on delete cascade,
  profile_id uuid not null references profile (id) on delete cascade,
  provider_record_id text not null,
  recorded_at timestamptz not null,
  provenance wearable_measurement_provenance not null,
  synced_at timestamptz not null,
  workout_type text not null,
  duration_minutes numeric not null check (duration_minutes > 0),
  energy_kcal numeric check (energy_kcal is null or energy_kcal >= 0),
  avg_heart_rate numeric check (avg_heart_rate is null or avg_heart_rate > 0),
  created_at timestamptz not null default now(),
  unique (wearable_connection_id, provider_record_id)
);

create index idx_workout_profile_id on workout (profile_id, recorded_at);

create table sleep (
  id uuid primary key default gen_random_uuid(),
  wearable_connection_id uuid not null references wearable_connection (id) on delete cascade,
  profile_id uuid not null references profile (id) on delete cascade,
  provider_record_id text not null,
  recorded_at timestamptz not null,
  provenance wearable_measurement_provenance not null,
  synced_at timestamptz not null,
  sleep_start_at timestamptz not null,
  sleep_end_at timestamptz not null,
  sleep_stage_breakdown jsonb,
  created_at timestamptz not null default now(),
  unique (wearable_connection_id, provider_record_id),
  constraint sleep_end_after_start check (sleep_end_at > sleep_start_at)
);

create index idx_sleep_profile_id on sleep (profile_id, recorded_at);

create table recovery (
  id uuid primary key default gen_random_uuid(),
  wearable_connection_id uuid not null references wearable_connection (id) on delete cascade,
  profile_id uuid not null references profile (id) on delete cascade,
  provider_record_id text not null,
  recorded_at timestamptz not null,
  provenance wearable_measurement_provenance not null,
  synced_at timestamptz not null,
  recovery_score numeric check (recovery_score is null or (recovery_score >= 0 and recovery_score <= 100)),
  hrv_ms numeric check (hrv_ms is null or hrv_ms >= 0),
  resting_heart_rate numeric check (resting_heart_rate is null or resting_heart_rate > 0),
  created_at timestamptz not null default now(),
  unique (wearable_connection_id, provider_record_id)
);

create index idx_recovery_profile_id on recovery (profile_id, recorded_at);
