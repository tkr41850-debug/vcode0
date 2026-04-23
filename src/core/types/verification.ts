import type { TaskId } from './workflow.js';

export interface DependencyOutputSummary {
  taskId: TaskId;
  featureName: string;
  summary: string;
  filesChanged: string[];
}

export type VerificationOutcome = 'pass' | 'repair_needed';

export type VerificationCriterionStatus = 'met' | 'missing' | 'failed';

export interface VerificationCriterionEvidence {
  criterion: string;
  status: VerificationCriterionStatus;
  evidence: string;
}

export interface VerificationSummary {
  ok: boolean;
  summary?: string;
  failedChecks?: string[];
  outcome?: VerificationOutcome;
  criteriaEvidence?: VerificationCriterionEvidence[];
  repairFocus?: string[];
  issues?: VerifyIssue[];
}

export interface VerificationCheck {
  description: string;
  command: string;
}

export interface VerificationLayerConfig {
  checks: VerificationCheck[];
  timeoutSecs: number;
  continueOnFail: boolean;
}

export interface VerificationConfig {
  task?: VerificationLayerConfig;
  feature?: VerificationLayerConfig;
}

export type VerifyIssueSeverity = 'blocking' | 'concern' | 'nit';

export type VerifyIssueSource = 'verify' | 'ci_check' | 'rebase';

export type CiCheckPhase = 'feature' | 'post_rebase';

interface VerifyIssueBase {
  id: string;
  severity: VerifyIssueSeverity;
  description: string;
}

export interface VerifyAgentVerifyIssue extends VerifyIssueBase {
  source: 'verify';
  location?: string;
  suggestedFix?: string;
}

export interface CiCheckVerifyIssue extends VerifyIssueBase {
  source: 'ci_check';
  phase: CiCheckPhase;
  checkName: string;
  command: string;
  exitCode?: number;
  output?: string;
}

export interface RebaseVerifyIssue extends VerifyIssueBase {
  source: 'rebase';
  conflictedFiles: string[];
}

export type VerifyIssue =
  | VerifyAgentVerifyIssue
  | CiCheckVerifyIssue
  | RebaseVerifyIssue;

export interface IntegrationState {
  featureId: string;
  expectedParentSha: string;
  featureBranchPreIntegrationSha: string;
  configSnapshot: string;
  intent: 'integrate' | 'cancel';
  startedAt: number;
}
