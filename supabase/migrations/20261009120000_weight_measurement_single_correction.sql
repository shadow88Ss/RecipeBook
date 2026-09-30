-- Layer 10B closure — single correction chain for WeightMeasurement.
--
-- Additive. At most ONE WeightMeasurement may directly correct a given
-- measurement, so history is a chain (A -> B -> C, C active), never a
-- branch (A -> B and A -> C). A unique index is enforced by the database
-- itself, so two concurrent corrections of the same measurement cannot both
-- commit (the second fails with 23505 and the API returns 409).
--
-- Existing history is never deleted or rewritten. If a database already
-- holds a correction branch, this migration refuses to install (the index
-- would fail anyway) with an explicit message instead of choosing a branch;
-- resolving such data is a product decision (00_Master.md §6.9).

do $$
declare
  branched int;
begin
  select count(*) into branched
  from (
    select corrects_measurement_id
    from weight_measurement
    where corrects_measurement_id is not null
    group by corrects_measurement_id
    having count(*) > 1
  ) b;
  if branched > 0 then
    raise exception 'weight_measurement has % measurement(s) with more than one direct correction; refusing to add the single-correction invariant without an approved migration decision (no history was changed)', branched;
  end if;
end;
$$;

create unique index uq_weight_measurement_single_correction
  on weight_measurement (corrects_measurement_id)
  where corrects_measurement_id is not null;
