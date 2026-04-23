-- 0003_agent_runs_worker_pid.sql
-- Phase 3 worker execution loop: persist worker PIDs across fork/exit lifecycle
-- so Phase 9 crash recovery can reconcile which workers were alive at crash time.
--
-- Additive, nullable column — existing rows populate as NULL. The partial index
-- mirrors `Store.getLiveWorkerPids()` which always filters
-- `WHERE worker_pid IS NOT NULL`; keeping the index partial keeps it tiny
-- (typically bounded by the worker pool size, not the total run history).
--
-- No foreign-key to any process table (there is no such table). PIDs are
-- OS-ephemeral integers; SQLite just stores the number.

ALTER TABLE agent_runs ADD COLUMN worker_pid INTEGER NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_worker_pid
  ON agent_runs(worker_pid) WHERE worker_pid IS NOT NULL;
