import type { Decision, Finding, TaskResult } from './phases.js';
import type { TokenUsageAggregate } from './usage.js';
import type { VerifyIssue } from './verification.js';
import type {
  FeatureCollabControl,
  FeatureId,
  FeatureWorkControl,
  MilestoneId,
  RepairSource,
  TaskCollabControl,
  TaskId,
  TaskStatus,
  TaskSuspendReason,
  TaskWeight,
  TestPolicy,
  UnitStatus,
} from './workflow.js';

export interface Milestone {
  id: MilestoneId;
  name: string;
  description: string;
  status: UnitStatus;
  order: number;
  steeringQueuePosition?: number;
}

export interface Feature {
  id: FeatureId;
  milestoneId: MilestoneId;
  orderInMilestone: number;
  name: string;
  description: string;
  dependsOn: FeatureId[];
  status: UnitStatus;
  workControl: FeatureWorkControl;
  collabControl: FeatureCollabControl;
  featureBranch: string;
  featureTestPolicy?: TestPolicy;
  mergeTrainManualPosition?: number;
  mergeTrainEnteredAt?: number;
  mergeTrainEntrySeq?: number;
  mergeTrainReentryCount?: number;
  runtimeBlockedByFeatureId?: FeatureId;
  summary?: string;
  tokenUsage?: TokenUsageAggregate;
  roughDraft?: string;
  discussOutput?: Decision[];
  researchOutput?: Finding[];
  featureObjective?: string;
  featureDoD?: string[];
  verifyIssues?: VerifyIssue[];
}

export interface Task {
  id: TaskId;
  featureId: FeatureId;
  orderInFeature: number;
  description: string;
  dependsOn: TaskId[];
  status: TaskStatus;
  collabControl: TaskCollabControl;
  repairSource?: RepairSource;
  workerId?: string;
  worktreeBranch?: string;
  taskTestPolicy?: TestPolicy;
  result?: TaskResult;
  weight?: TaskWeight;
  tokenUsage?: TokenUsageAggregate;
  reservedWritePaths?: string[];
  blockedByFeatureId?: FeatureId;
  sessionId?: string;
  consecutiveFailures?: number;
  suspendedAt?: number;
  suspendReason?: TaskSuspendReason;
  suspendedFiles?: string[];
  objective?: string;
  scope?: string;
  expectedFiles?: string[];
  references?: string[];
  outcomeVerification?: string;
}
