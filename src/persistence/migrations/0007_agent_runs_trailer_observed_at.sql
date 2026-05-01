-- 0007_agent_runs_trailer_observed_at.sql
-- Plan 05-04: persist when a worker run first produced a trailer-valid commit
-- (Store.setTrailerObservedAt / getTrailerObservedAt). Scheduler commit-gate
-- logic uses NULL to mean "no trailer-ok commit observed yet".
--
-- Additive, nullable column — existing rows populate as NULL. No index:
-- access is always by the primary-key `id` on agent_runs, and the column is
-- read as a scalar audit field.

ALTER TABLE agent_runs ADD COLUMN trailer_observed_at INTEGER NULL;
