-- 0006_agent_runs_last_commit_sha.sql
-- Plan 03-03: persist the SHA of the last commit produced by a worker run
-- (Store.setLastCommitSha). Phase 6 merge-train consumes this column as a
-- faster index than mining commit trailers from the reflog; the trailer
-- contract (gvc0-task-id=<id>, gvc0-run-id=<runId>) remains authoritative,
-- this column is a convenience index.
--
-- Additive, nullable column — existing rows populate as NULL. No index:
-- Phase 6 reads by `id` (the PK on agent_runs) and uses this column as a
-- scalar value; a secondary index would not be justified.
--
-- Filename 0006 was pre-allocated at Phase-3 planning time alongside 0005.

ALTER TABLE agent_runs ADD COLUMN last_commit_sha TEXT NULL;
