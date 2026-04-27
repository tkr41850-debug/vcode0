import { Type } from '@sinclair/typebox';

const featurePatchSchema = Type.Object({
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  roughDraft: Type.Optional(Type.String()),
  featureObjective: Type.Optional(Type.String()),
  featureDoD: Type.Optional(Type.Array(Type.String())),
});

const taskPatchSchema = Type.Object({
  description: Type.Optional(Type.String()),
  weight: Type.Optional(
    Type.Union([
      Type.Literal('trivial'),
      Type.Literal('small'),
      Type.Literal('medium'),
      Type.Literal('heavy'),
    ]),
  ),
  reservedWritePaths: Type.Optional(Type.Array(Type.String())),
  objective: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
  expectedFiles: Type.Optional(Type.Array(Type.String())),
  references: Type.Optional(Type.Array(Type.String())),
  outcomeVerification: Type.Optional(Type.String()),
});

const dependencySchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
});

const verificationCriterionSchema = Type.Object({
  criterion: Type.String(),
  status: Type.Union([
    Type.Literal('met'),
    Type.Literal('missing'),
    Type.Literal('failed'),
  ]),
  evidence: Type.String(),
});

const discussSubmitSchema = Type.Object({
  summary: Type.String(),
  intent: Type.String(),
  successCriteria: Type.Array(Type.String()),
  constraints: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  externalIntegrations: Type.Array(Type.String()),
  antiGoals: Type.Array(Type.String()),
  openQuestions: Type.Array(Type.String()),
});

const researchFileSchema = Type.Object({
  path: Type.String(),
  responsibility: Type.String(),
});

const researchSubmitSchema = Type.Object({
  summary: Type.String(),
  existingBehavior: Type.String(),
  essentialFiles: Type.Array(researchFileSchema),
  reusePatterns: Type.Array(Type.String()),
  riskyBoundaries: Type.Array(Type.String()),
  proofsNeeded: Type.Array(Type.String()),
  verificationSurfaces: Type.Array(Type.String()),
  planningNotes: Type.Array(Type.String()),
});

const summarizeSubmitSchema = Type.Object({
  summary: Type.String(),
  outcome: Type.String(),
  deliveredCapabilities: Type.Array(Type.String()),
  importantFiles: Type.Array(Type.String()),
  verificationConfidence: Type.Array(Type.String()),
  carryForwardNotes: Type.Array(Type.String()),
});

const proposalSubmitSchema = Type.Object({
  summary: Type.String(),
  chosenApproach: Type.String(),
  keyConstraints: Type.Array(Type.String()),
  decompositionRationale: Type.Array(Type.String()),
  orderingRationale: Type.Array(Type.String()),
  verificationExpectations: Type.Array(Type.String()),
  risksTradeoffs: Type.Array(Type.String()),
  assumptions: Type.Array(Type.String()),
});

export const proposalToolParameters = {
  addMilestone: Type.Object({
    name: Type.String(),
    description: Type.String(),
  }),
  addFeature: Type.Object({
    milestoneId: Type.String(),
    name: Type.String(),
    description: Type.String(),
  }),
  removeFeature: Type.Object({
    featureId: Type.String(),
  }),
  editFeature: Type.Object({
    featureId: Type.String(),
    patch: featurePatchSchema,
  }),
  addTask: Type.Object({
    featureId: Type.String(),
    description: Type.String(),
    weight: Type.Optional(
      Type.Union([
        Type.Literal('trivial'),
        Type.Literal('small'),
        Type.Literal('medium'),
        Type.Literal('heavy'),
      ]),
    ),
    reservedWritePaths: Type.Optional(Type.Array(Type.String())),
    objective: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
    expectedFiles: Type.Optional(Type.Array(Type.String())),
    references: Type.Optional(Type.Array(Type.String())),
    outcomeVerification: Type.Optional(Type.String()),
  }),
  setFeatureObjective: Type.Object({
    featureId: Type.String(),
    objective: Type.String(),
  }),
  setFeatureDoD: Type.Object({
    featureId: Type.String(),
    dod: Type.Array(Type.String()),
  }),
  removeTask: Type.Object({
    taskId: Type.String(),
  }),
  editTask: Type.Object({
    taskId: Type.String(),
    patch: taskPatchSchema,
  }),
  addDependency: dependencySchema,
  removeDependency: dependencySchema,
  submit: proposalSubmitSchema,
} as const;

export const featurePhaseToolParameters = {
  getFeatureState: Type.Object({
    featureId: Type.Optional(Type.String()),
  }),
  listFeatureTasks: Type.Object({
    featureId: Type.Optional(Type.String()),
  }),
  getTaskResult: Type.Object({
    taskId: Type.String(),
  }),
  listFeatureEvents: Type.Object({
    featureId: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  }),
  listFeatureRuns: Type.Object({
    featureId: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
  }),
  getChangedFiles: Type.Object({
    featureId: Type.Optional(Type.String()),
  }),
  submitDiscuss: discussSubmitSchema,
  submitResearch: researchSubmitSchema,
  submitSummarize: summarizeSubmitSchema,
  submitVerify: Type.Object({
    outcome: Type.Union([Type.Literal('pass'), Type.Literal('replan_needed')]),
    summary: Type.String(),
    failedChecks: Type.Optional(Type.Array(Type.String())),
    criteriaEvidence: Type.Optional(Type.Array(verificationCriterionSchema)),
    repairFocus: Type.Optional(Type.Array(Type.String())),
  }),
  raiseIssue: Type.Object({
    severity: Type.Union([
      Type.Literal('blocking'),
      Type.Literal('concern'),
      Type.Literal('nit'),
    ]),
    description: Type.String(),
    location: Type.Optional(Type.String()),
    suggestedFix: Type.Optional(Type.String()),
  }),
} as const;
