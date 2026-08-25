-- Phase 1 — Layer 1: Database Foundation
-- Enum types for all Phase 1 entities per 29_Data_Model.md and 29_Data_Model_Data_Dictionary.md.
-- Naming: PascalCase entity/field names in the specifications map to snake_case
-- identifiers here (standard SQL convention translation, not a semantic rename).

create type auth_identity_provider as enum ('apple', 'google', 'email');

create type device_type as enum ('ios', 'android');

create type device_session_revoked_reason as enum (
  'user_logout',
  'user_logout_all',
  'lost_device',
  'security_revocation'
);

-- Fixed Phase 1 set per 29_Data_Model.md §11. Do not repurpose or redefine
-- these three values; additional values may only be appended by an approved
-- later specification (19_Family_and_Multi_Profile.md / 21_Pediatric_Weight_Management.md).
create type guardian_authorization_scope as enum (
  'full_management',
  'pediatric_weight_management',
  'view_only'
);

create type goal_type as enum (
  'weight_loss',
  'maintenance',
  'weight_gain',
  'micronutrient_improvement',
  'fiber_improvement',
  'other'
);

create type clinician_target_source_type as enum (
  'guardian_entered',
  'user_entered',
  'clinician_integration'
);

create type clinician_target_verification_status as enum ('unverified', 'platform_verified');

create type weight_measurement_source as enum ('user_entered', 'wearable_synced', 'clinician_entered');

create type effective_target_snapshot_reason as enum (
  'meal_consumed',
  'daily_summary_finalized',
  'coach_recommendation_issued',
  'user_requested_export',
  'manual_audit'
);

create type effective_target_linked_event_type as enum (
  'consumed_meal',
  'daily_summary_finalized',
  'coach_recommendation',
  'other_auditable_decision'
);

create type meal_type as enum ('breakfast', 'lunch', 'dinner', 'snack', 'other');

-- Canonical Phase 1 meal lifecycle enum (00_Master.md §6, 29_Data_Model.md §3).
create type meal_item_status as enum ('draft', 'planned', 'confirmed', 'consumed', 'skipped', 'cancelled');

create type meal_item_actor_type as enum ('user', 'ai_optimizer', 'system');

-- Full source vocabulary (Food, FoodNutrient).
create type food_data_source as enum ('trusted_database', 'manufacturer_label', 'user_entered', 'ai_matched');

-- Narrower source vocabulary (FoodAlias, FoodServing — no manufacturer_label).
create type food_alias_serving_source as enum ('trusted_database', 'user_entered', 'ai_matched');

create type recipe_visibility as enum ('private', 'shared_library');

create type recipe_ingredient_match_status as enum ('matched', 'needs_confirmation', 'unmatched');

create type url_source_provider as enum ('instagram', 'tiktok', 'youtube', 'web', 'manual');

-- Canonical Phase 1 import processing enum (29_Data_Model.md §7.3).
create type import_trigger_type as enum ('initial_import', 'retry', 'manual_reimport', 'scheduled_recheck');

create type import_processing_status as enum (
  'queued',
  'processing',
  'needs_confirmation',
  'succeeded',
  'retryable_failed',
  'permanently_failed',
  'cancelled'
);

create type raw_content_type as enum ('html', 'json', 'image', 'video', 'transcript');

create type ai_extraction_source as enum ('photo', 'voice_transcript', 'url_import', 'barcode_lookup_ambiguity');

-- Aligned naming with import_processing_status's needs_confirmation value (29_Data_Model.md §9).
create type ai_extraction_status as enum (
  'success',
  'partial_success',
  'needs_confirmation',
  'retryable_failure',
  'permanent_failure'
);

create type wearable_provider as enum ('whoop', 'apple_healthkit', 'android_health_connect');

create type wearable_sync_status as enum ('success', 'partial', 'retryable_failure', 'permanent_failure');

create type wearable_measurement_provenance as enum ('wearable_direct', 'wearable_derived', 'user_override');

create type audit_actor_type as enum ('user', 'system', 'ai_optimizer', 'worker');
