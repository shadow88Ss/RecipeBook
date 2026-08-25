-- Phase 1 — Layer 1: Database Foundation
-- Shared trigger functions used across multiple entity migrations.

-- Maintains `updated_at` on any table that has the column.
create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Attached to tables whose rows must never be mutated after creation
-- (RecipeVersion, RecipeIngredient, RecipeInstruction, RawContent, AiExtraction,
-- EffectiveTargetSnapshot, WeightMeasurement). DELETE remains possible where the
-- data model's retention rule permits cascade-deletion from a parent (e.g. profile
-- or recipe deletion) — only UPDATE is blocked here. Write-privilege lockdown
-- (which roles may DELETE at all) is a Layer 2 (RLS/authorization) concern.
create function prevent_update()
returns trigger
language plpgsql
as $$
begin
  raise exception '% rows are immutable once created (id=%)', tg_table_name, old.id;
  return null;
end;
$$;

-- Attached only to AuditEvent: no legitimate UPDATE or DELETE path exists for
-- an audit record at any layer (00_Master.md §14.5 — not user-deletable; purged
-- only per a documented log-retention schedule, which is out of Phase 1 scope).
create function prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% rows are append-only (id=%)', tg_table_name, coalesce(old.id, new.id);
  return null;
end;
$$;
