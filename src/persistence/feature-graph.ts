import type {
  AddTaskOptions,
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  DependencyOptions,
  FeatureEditPatch,
  FeatureGraph,
  FeatureTransitionPatch,
  GraphSnapshot,
  MergeTrainUpdate,
  TaskEditPatch,
  TaskTransitionPatch,
  UsageRollupPatch,
} from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
  TaskWeight,
} from '@core/types/index';
import {
  featureToRow,
  milestoneToRow,
  rowToFeature,
  rowToMilestone,
  rowToTask,
  taskToRow,
} from '@persistence/codecs';
import type {
  DependencyRow,
  FeatureRow,
  MilestoneRow,
  TaskRow,
} from '@persistence/queries/index';
import type Database from 'better-sqlite3';

const MILESTONE_COLUMNS =
  'id, name, description, display_order, steering_queue_position, status, created_at, updated_at';

const FEATURE_COLUMNS =
  'id, milestone_id, order_in_milestone, name, description, status, work_phase, collab_status, feature_branch, feature_test_policy, merge_train_manual_position, merge_train_entered_at, merge_train_entry_seq, merge_train_reentry_count, runtime_blocked_by_feature_id, summary, token_usage, rough_draft, discuss_output, research_output, feature_objective, feature_dod, verify_issues, main_merge_sha, branch_head_sha, created_at, updated_at';

const TASK_COLUMNS =
  'id, feature_id, order_in_feature, description, weight, status, collab_status, worker_id, worktree_branch, reserved_write_paths, blocked_by_feature_id, result_summary, files_changed, token_usage, task_test_policy, session_id, consecutive_failures, suspended_at, suspend_reason, suspended_files, objective, scope, expected_files, references_json, outcome_verification, branch_head_sha, created_at, updated_at';

interface PreparedStatements {
  selectMilestones: Database.Statement<[], MilestoneRow>;
  selectFeatures: Database.Statement<[], FeatureRow>;
  selectTasks: Database.Statement<[], TaskRow>;
  selectDeps: Database.Statement<[], DependencyRow>;
  upsertMilestone: Database.Statement<Record<string, unknown>>;
  deleteMilestone: Database.Statement<[string]>;
  upsertFeature: Database.Statement<Record<string, unknown>>;
  deleteFeature: Database.Statement<[string]>;
  upsertTask: Database.Statement<Record<string, unknown>>;
  deleteTask: Database.Statement<[string]>;
  deleteFeatureDepsFrom: Database.Statement<[string]>;
  deleteTaskDepsFrom: Database.Statement<[string]>;
  deleteDepsInvolving: Database.Statement<{ id: string }>;
  insertDep: Database.Statement<{
    from_id: string;
    to_id: string;
    dep_type: string;
  }>;
}

/**
 * SQLite-backed FeatureGraph decorator.
 *
 * On construction it rehydrates an InMemoryFeatureGraph from the current
 * database rows. All read operations delegate to the inner graph. All
 * mutating operations run under a snapshot-and-rollback pattern:
 *
 *  1. Capture the inner snapshot before the call.
 *  2. Delegate to the inner graph (which validates and mutates in memory).
 *  3. Compute a diff between the before/after snapshots by reference
 *     equality — InMemoryFeatureGraph immutably replaces mutated entities
 *     so a ref mismatch correctly identifies every change.
 *  4. Write the diff inside a single SQL transaction.
 *  5. If the SQL write throws, restore the inner graph from the
 *     before-snapshot and re-throw.
 *
 * A failed mutation leaves the database unchanged and in-memory state
 * restored. Cached references to `milestones`/`features`/`tasks` held
 * across a failed mutation are stale and should be re-read from the
 * graph after the error.
 */
export class PersistentFeatureGraph implements FeatureGraph {
  private inner: InMemoryFeatureGraph;
  private readonly statements: PreparedStatements;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.statements = this.prepareStatements();
    this.inner = new InMemoryFeatureGraph(this.loadSnapshot());
  }

  // ---------- Delegated readonly map views ----------

  get milestones(): Map<MilestoneId, Milestone> {
    return this.inner.milestones;
  }

  get features(): Map<FeatureId, Feature> {
    return this.inner.features;
  }

  get tasks(): Map<TaskId, Task> {
    return this.inner.tasks;
  }

  // ---------- Delegated reads ----------

  snapshot(): GraphSnapshot {
    return this.inner.snapshot();
  }

  readyFeatures(): Feature[] {
    return this.inner.readyFeatures();
  }

  readyTasks(): Task[] {
    return this.inner.readyTasks();
  }

  queuedMilestones(): Milestone[] {
    return this.inner.queuedMilestones();
  }

  isComplete(): boolean {
    return this.inner.isComplete();
  }

  // ---------- Mutations ----------

  createMilestone(opts: CreateMilestoneOptions): Milestone {
    return this.mutate(() => this.inner.createMilestone(opts));
  }

  createFeature(opts: CreateFeatureOptions): Feature {
    return this.mutate(() => this.inner.createFeature(opts));
  }

  createTask(opts: CreateTaskOptions): Task {
    return this.mutate(() => this.inner.createTask(opts));
  }

  addDependency(opts: DependencyOptions): void {
    this.mutate(() => this.inner.addDependency(opts));
  }

  removeDependency(opts: DependencyOptions): void {
    this.mutate(() => this.inner.removeDependency(opts));
  }

  cancelFeature(featureId: FeatureId, cascade?: boolean): void {
    this.mutate(() => this.inner.cancelFeature(featureId, cascade));
  }

  removeFeature(featureId: FeatureId): void {
    this.mutate(() => this.inner.removeFeature(featureId));
  }

  changeMilestone(featureId: FeatureId, newMilestoneId: MilestoneId): void {
    this.mutate(() => this.inner.changeMilestone(featureId, newMilestoneId));
  }

  editFeature(featureId: FeatureId, patch: FeatureEditPatch): Feature {
    return this.mutate(() => this.inner.editFeature(featureId, patch));
  }

  addTask(opts: AddTaskOptions): Task {
    return this.mutate(() => this.inner.addTask(opts));
  }

  editTask(taskId: TaskId, patch: TaskEditPatch): Task {
    return this.mutate(() => this.inner.editTask(taskId, patch));
  }

  removeTask(taskId: TaskId): void {
    this.mutate(() => this.inner.removeTask(taskId));
  }

  reorderTasks(featureId: FeatureId, taskIds: TaskId[]): void {
    this.mutate(() => this.inner.reorderTasks(featureId, taskIds));
  }

  reweight(taskId: TaskId, weight: TaskWeight): void {
    this.mutate(() => this.inner.reweight(taskId, weight));
  }

  queueMilestone(milestoneId: MilestoneId): void {
    this.mutate(() => this.inner.queueMilestone(milestoneId));
  }

  dequeueMilestone(milestoneId: MilestoneId): void {
    this.mutate(() => this.inner.dequeueMilestone(milestoneId));
  }

  clearQueuedMilestones(): void {
    this.mutate(() => this.inner.clearQueuedMilestones());
  }

  transitionFeature(featureId: FeatureId, patch: FeatureTransitionPatch): void {
    this.mutate(() => this.inner.transitionFeature(featureId, patch));
  }

  transitionTask(taskId: TaskId, patch: TaskTransitionPatch): void {
    this.mutate(() => this.inner.transitionTask(taskId, patch));
  }

  updateMergeTrainState(featureId: FeatureId, fields: MergeTrainUpdate): void {
    this.mutate(() => this.inner.updateMergeTrainState(featureId, fields));
  }

  replaceUsageRollups(patch: UsageRollupPatch): void {
    this.mutate(() => this.inner.replaceUsageRollups(patch));
  }

  // ---------- Mutation helper ----------

  private mutate<T>(fn: () => T): T {
    const before = this.inner.snapshot();

    // If `fn` throws, the inner graph has already rejected the change and
    // SQL has not been touched, so we simply propagate the error.
    const result = fn();

    const after = this.inner.snapshot();

    try {
      this.db.transaction(() => {
        this.writeDiff(before, after);
      })();
    } catch (e) {
      this.inner = new InMemoryFeatureGraph(before);
      throw e;
    }

    return result;
  }

  // ---------- Diff writer ----------

  private writeDiff(before: GraphSnapshot, after: GraphSnapshot): void {
    const now = this.now();

    const beforeMilestones = new Map(before.milestones.map((m) => [m.id, m]));
    const afterMilestones = new Map(after.milestones.map((m) => [m.id, m]));
    const beforeFeatures = new Map(before.features.map((f) => [f.id, f]));
    const afterFeatures = new Map(after.features.map((f) => [f.id, f]));
    const beforeTasks = new Map(before.tasks.map((t) => [t.id, t]));
    const afterTasks = new Map(after.tasks.map((t) => [t.id, t]));

    // Deletes (child → parent order). `deleteDepsInvolving` covers both
    // outgoing and incoming dep rows in one shot.
    for (const [id] of beforeTasks) {
      if (!afterTasks.has(id)) {
        this.statements.deleteDepsInvolving.run({ id });
        this.statements.deleteTask.run(id);
      }
    }
    for (const [id] of beforeFeatures) {
      if (!afterFeatures.has(id)) {
        this.statements.deleteDepsInvolving.run({ id });
        this.statements.deleteFeature.run(id);
      }
    }
    for (const [id] of beforeMilestones) {
      if (!afterMilestones.has(id)) {
        this.statements.deleteMilestone.run(id);
      }
    }

    // Upserts (parent → child order).
    for (const [id, m] of afterMilestones) {
      if (beforeMilestones.get(id) !== m) {
        this.statements.upsertMilestone.run({
          ...milestoneToRow(m),
          created_at: now,
          updated_at: now,
        });
      }
    }
    for (const [id, f] of afterFeatures) {
      if (beforeFeatures.get(id) !== f) {
        this.statements.upsertFeature.run({
          ...featureToRow(f),
          created_at: now,
          updated_at: now,
        });
        // Sync outgoing feature dependencies.
        this.statements.deleteFeatureDepsFrom.run(id);
        for (const toId of f.dependsOn) {
          this.statements.insertDep.run({
            from_id: id,
            to_id: toId,
            dep_type: 'feature',
          });
        }
      }
    }
    for (const [id, t] of afterTasks) {
      if (beforeTasks.get(id) !== t) {
        this.statements.upsertTask.run({
          ...taskToRow(t),
          created_at: now,
          updated_at: now,
        });
        // Sync outgoing task dependencies.
        this.statements.deleteTaskDepsFrom.run(id);
        for (const toId of t.dependsOn) {
          this.statements.insertDep.run({
            from_id: id,
            to_id: toId,
            dep_type: 'task',
          });
        }
      }
    }
  }

  // ---------- Initial load ----------

  private loadSnapshot(): GraphSnapshot {
    const milestoneRows = this.statements.selectMilestones.all();
    const featureRows = this.statements.selectFeatures.all();
    const taskRows = this.statements.selectTasks.all();
    const depRows = this.statements.selectDeps.all();

    const featureDeps = new Map<FeatureId, FeatureId[]>();
    const taskDeps = new Map<TaskId, TaskId[]>();
    for (const dep of depRows) {
      if (dep.dep_type === 'feature') {
        const arr = featureDeps.get(dep.from_id) ?? [];
        arr.push(dep.to_id);
        featureDeps.set(dep.from_id, arr);
      } else {
        const arr = taskDeps.get(dep.from_id) ?? [];
        arr.push(dep.to_id);
        taskDeps.set(dep.from_id, arr);
      }
    }

    return {
      milestones: milestoneRows.map(rowToMilestone),
      features: featureRows.map((row) =>
        rowToFeature(row, featureDeps.get(row.id) ?? []),
      ),
      tasks: taskRows.map((row) => rowToTask(row, taskDeps.get(row.id) ?? [])),
    };
  }

  // ---------- Prepared statements ----------

  private prepareStatements(): PreparedStatements {
    const db = this.db;

    return {
      selectMilestones: db.prepare<[], MilestoneRow>(
        `SELECT ${MILESTONE_COLUMNS} FROM milestones ORDER BY id`,
      ),
      selectFeatures: db.prepare<[], FeatureRow>(
        `SELECT ${FEATURE_COLUMNS} FROM features ORDER BY id`,
      ),
      selectTasks: db.prepare<[], TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY id`,
      ),
      selectDeps: db.prepare<[], DependencyRow>(
        'SELECT from_id, to_id, dep_type FROM dependencies',
      ),

      upsertMilestone: db.prepare<Record<string, unknown>>(
        `INSERT INTO milestones (${MILESTONE_COLUMNS}) VALUES (
          :id, :name, :description, :display_order, :steering_queue_position,
          :status, :created_at, :updated_at
        ) ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          display_order = excluded.display_order,
          steering_queue_position = excluded.steering_queue_position,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      ),
      deleteMilestone: db.prepare<[string]>(
        'DELETE FROM milestones WHERE id = ?',
      ),

      upsertFeature: db.prepare<Record<string, unknown>>(
        `INSERT INTO features (${FEATURE_COLUMNS}) VALUES (
          :id, :milestone_id, :order_in_milestone, :name, :description,
          :status, :work_phase, :collab_status, :feature_branch,
          :feature_test_policy, :merge_train_manual_position,
          :merge_train_entered_at, :merge_train_entry_seq,
          :merge_train_reentry_count, :runtime_blocked_by_feature_id,
          :summary, :token_usage, :rough_draft, :discuss_output,
          :research_output, :feature_objective, :feature_dod,
          :verify_issues, :main_merge_sha, :branch_head_sha,
          :created_at, :updated_at
        ) ON CONFLICT(id) DO UPDATE SET
          milestone_id = excluded.milestone_id,
          order_in_milestone = excluded.order_in_milestone,
          name = excluded.name,
          description = excluded.description,
          status = excluded.status,
          work_phase = excluded.work_phase,
          collab_status = excluded.collab_status,
          feature_branch = excluded.feature_branch,
          feature_test_policy = excluded.feature_test_policy,
          merge_train_manual_position = excluded.merge_train_manual_position,
          merge_train_entered_at = excluded.merge_train_entered_at,
          merge_train_entry_seq = excluded.merge_train_entry_seq,
          merge_train_reentry_count = excluded.merge_train_reentry_count,
          runtime_blocked_by_feature_id = excluded.runtime_blocked_by_feature_id,
          summary = excluded.summary,
          token_usage = excluded.token_usage,
          rough_draft = excluded.rough_draft,
          discuss_output = excluded.discuss_output,
          research_output = excluded.research_output,
          feature_objective = excluded.feature_objective,
          feature_dod = excluded.feature_dod,
          verify_issues = excluded.verify_issues,
          main_merge_sha = excluded.main_merge_sha,
          branch_head_sha = excluded.branch_head_sha,
          updated_at = excluded.updated_at`,
      ),
      deleteFeature: db.prepare<[string]>('DELETE FROM features WHERE id = ?'),

      upsertTask: db.prepare<Record<string, unknown>>(
        `INSERT INTO tasks (${TASK_COLUMNS}) VALUES (
          :id, :feature_id, :order_in_feature, :description, :weight,
          :status, :collab_status, :worker_id, :worktree_branch,
          :reserved_write_paths, :blocked_by_feature_id, :result_summary,
          :files_changed, :token_usage, :task_test_policy, :session_id,
          :consecutive_failures, :suspended_at, :suspend_reason,
          :suspended_files, :objective, :scope, :expected_files,
          :references_json, :outcome_verification, :branch_head_sha,
          :created_at, :updated_at
        ) ON CONFLICT(id) DO UPDATE SET
          feature_id = excluded.feature_id,
          order_in_feature = excluded.order_in_feature,
          description = excluded.description,
          weight = excluded.weight,
          status = excluded.status,
          collab_status = excluded.collab_status,
          worker_id = excluded.worker_id,
          worktree_branch = excluded.worktree_branch,
          reserved_write_paths = excluded.reserved_write_paths,
          blocked_by_feature_id = excluded.blocked_by_feature_id,
          result_summary = excluded.result_summary,
          files_changed = excluded.files_changed,
          token_usage = excluded.token_usage,
          task_test_policy = excluded.task_test_policy,
          session_id = excluded.session_id,
          consecutive_failures = excluded.consecutive_failures,
          suspended_at = excluded.suspended_at,
          suspend_reason = excluded.suspend_reason,
          suspended_files = excluded.suspended_files,
          objective = excluded.objective,
          scope = excluded.scope,
          expected_files = excluded.expected_files,
          references_json = excluded.references_json,
          outcome_verification = excluded.outcome_verification,
          branch_head_sha = excluded.branch_head_sha,
          updated_at = excluded.updated_at`,
      ),
      deleteTask: db.prepare<[string]>('DELETE FROM tasks WHERE id = ?'),

      deleteFeatureDepsFrom: db.prepare<[string]>(
        "DELETE FROM dependencies WHERE from_id = ? AND dep_type = 'feature'",
      ),
      deleteTaskDepsFrom: db.prepare<[string]>(
        "DELETE FROM dependencies WHERE from_id = ? AND dep_type = 'task'",
      ),
      deleteDepsInvolving: db.prepare<{ id: string }>(
        'DELETE FROM dependencies WHERE from_id = :id OR to_id = :id',
      ),
      insertDep: db.prepare<{
        from_id: string;
        to_id: string;
        dep_type: string;
      }>(
        'INSERT OR IGNORE INTO dependencies (from_id, to_id, dep_type) VALUES (:from_id, :to_id, :dep_type)',
      ),
    };
  }
}
