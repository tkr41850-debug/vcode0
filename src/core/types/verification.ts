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
  mergeTrain?: VerificationLayerConfig;
}

export type VerifyIssueSeverity = 'blocking' | 'concern' | 'nit';

export interface VerifyIssue {
  id: string;
  severity: VerifyIssueSeverity;
  description: string;
  location?: string;
  suggestedFix?: string;
}
