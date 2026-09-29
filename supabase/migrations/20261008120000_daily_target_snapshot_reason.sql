-- Phase 3 — Layer 10A (part 1 of 2): the `daily_tracking` snapshot reason.
--
-- Additive. Kept in its own migration because a newly added enum value
-- cannot be used (index predicate, check) in the same transaction that adds
-- it; 20261008120100_daily_target_snapshots.sql uses it.

alter type effective_target_snapshot_reason add value if not exists 'daily_tracking';
