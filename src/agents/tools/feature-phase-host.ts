import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  DiscussPhaseResult,
  EventRecord,
  Feature,
  FeatureId,
  ResearchPhaseResult,
  SummarizePhaseResult,
  Task,
  VerificationSummary,
} from '@core/types/index';
import type { Store } from '@orchestrator/ports/index';

import type {
  FeaturePhaseToolHost,
  GetChangedFilesOptions,
  GetFeatureStateOptions,
  GetTaskResultOptions,
  ListFeatureEventsOptions,
  ListFeatureRunsOptions,
  ListFeatureTasksOptions,
  SubmitDiscussOptions,
  SubmitResearchOptions,
  SubmitSummarizeOptions,
  SubmitVerifyOptions,
  TaskResultLookup,
} from './types.js';

class DefaultFeaturePhaseToolHost implements FeaturePhaseToolHost {
  private discuss: DiscussPhaseResult | undefined;
  private research: ResearchPhaseResult | undefined;
  private summarize: SummarizePhaseResult | undefined;
  private verification: VerificationSummary | undefined;

  constructor(
    private readonly featureId: FeatureId,
    private readonly graph: FeatureGraph,
    private readonly store: Pick<Store, 'listAgentRuns' | 'listEvents'>,
  ) {}

  getFeatureState(args: GetFeatureStateOptions): Feature {
    return this.requireFeature(this.resolveFeatureId(args.featureId));
  }

  listFeatureTasks(args: ListFeatureTasksOptions): Task[] {
    const featureId = this.resolveFeatureId(args.featureId);
    return [...this.graph.tasks.values()]
      .filter((task) => task.featureId === featureId)
      .sort((a, b) => a.orderInFeature - b.orderInFeature);
  }

  getTaskResult(args: GetTaskResultOptions): TaskResultLookup {
    const task = this.graph.tasks.get(args.taskId);
    if (task === undefined) {
      throw new Error(`task "${args.taskId}" does not exist`);
    }
    if (task.result === undefined) {
      throw new Error(`task "${args.taskId}" has no recorded result`);
    }
    return {
      taskId: task.id,
      featureId: task.featureId,
      result: task.result,
    };
  }

  listFeatureEvents(args: ListFeatureEventsOptions): EventRecord[] {
    const featureId = this.resolveFeatureId(args.featureId);
    const events = this.store
      .listEvents({ entityId: featureId })
      .filter((event) =>
        args.phase === undefined ? true : readEventPhase(event) === args.phase,
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    if (args.limit === undefined) {
      return events;
    }
    return events.slice(-args.limit);
  }

  listFeatureRuns(args: ListFeatureRunsOptions): AgentRun[] {
    const featureId = this.resolveFeatureId(args.featureId);
    return this.store
      .listAgentRuns({
        scopeType: 'feature_phase',
        scopeId: featureId,
        ...(args.phase !== undefined ? { phase: args.phase } : {}),
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  getChangedFiles(args: GetChangedFilesOptions): string[] {
    const tasks = this.listFeatureTasks(
      args.featureId !== undefined ? { featureId: args.featureId } : {},
    );
    const files = new Set<string>();
    for (const task of tasks) {
      for (const file of task.result?.filesChanged ?? []) {
        const trimmed = file.trim();
        if (trimmed.length > 0) {
          files.add(trimmed);
        }
      }
    }
    return [...files];
  }

  submitDiscuss(args: SubmitDiscussOptions): DiscussPhaseResult {
    if (this.discuss !== undefined) {
      throw new Error('discuss phase already submitted');
    }
    const { summary, ...extra } = args;
    const result: DiscussPhaseResult = {
      summary,
      extra,
    };
    this.discuss = result;
    return result;
  }

  submitResearch(args: SubmitResearchOptions): ResearchPhaseResult {
    if (this.research !== undefined) {
      throw new Error('research phase already submitted');
    }
    const { summary, ...extra } = args;
    const result: ResearchPhaseResult = {
      summary,
      extra,
    };
    this.research = result;
    return result;
  }

  submitSummarize(args: SubmitSummarizeOptions): SummarizePhaseResult {
    if (this.summarize !== undefined) {
      throw new Error('summarize phase already submitted');
    }
    const { summary, ...extra } = args;
    const result: SummarizePhaseResult = {
      summary,
      extra,
    };
    this.summarize = result;
    return result;
  }

  submitVerify(args: SubmitVerifyOptions): VerificationSummary {
    if (this.verification !== undefined) {
      throw new Error('verify phase already submitted');
    }
    const fallbackFailedChecks =
      args.outcome === 'repair_needed'
        ? args.failedChecks && args.failedChecks.length > 0
          ? args.failedChecks
          : args.repairFocus && args.repairFocus.length > 0
            ? args.repairFocus
            : [args.summary]
        : undefined;
    const verification: VerificationSummary = {
      ok: args.outcome === 'pass',
      summary: args.summary,
      outcome: args.outcome,
      ...(fallbackFailedChecks !== undefined
        ? { failedChecks: fallbackFailedChecks }
        : {}),
      ...(args.criteriaEvidence !== undefined &&
      args.criteriaEvidence.length > 0
        ? { criteriaEvidence: args.criteriaEvidence }
        : {}),
      ...(args.repairFocus !== undefined && args.repairFocus.length > 0
        ? { repairFocus: args.repairFocus }
        : {}),
    };
    this.verification = verification;
    return verification;
  }

  wasDiscussSubmitted(): boolean {
    return this.discuss !== undefined;
  }

  wasResearchSubmitted(): boolean {
    return this.research !== undefined;
  }

  wasSummarizeSubmitted(): boolean {
    return this.summarize !== undefined;
  }

  wasVerifySubmitted(): boolean {
    return this.verification !== undefined;
  }

  getDiscussSummary(): DiscussPhaseResult {
    if (this.discuss === undefined) {
      throw new Error(
        'discuss phase must call submitDiscuss before completion',
      );
    }
    return this.discuss;
  }

  getResearchSummary(): ResearchPhaseResult {
    if (this.research === undefined) {
      throw new Error(
        'research phase must call submitResearch before completion',
      );
    }
    return this.research;
  }

  getSummarizeSummary(): SummarizePhaseResult {
    if (this.summarize === undefined) {
      throw new Error(
        'summarize phase must call submitSummarize before completion',
      );
    }
    return this.summarize;
  }

  getVerificationSummary(): VerificationSummary {
    if (this.verification === undefined) {
      throw new Error('verify phase must call submitVerify before completion');
    }
    return this.verification;
  }

  private resolveFeatureId(featureId: FeatureId | undefined): FeatureId {
    return featureId ?? this.featureId;
  }

  private requireFeature(featureId: FeatureId): Feature {
    const feature = this.graph.features.get(featureId);
    if (feature === undefined) {
      throw new Error(`feature "${featureId}" does not exist`);
    }
    return feature;
  }
}

export function createFeaturePhaseToolHost(
  featureId: FeatureId,
  graph: FeatureGraph,
  store: Pick<Store, 'listAgentRuns' | 'listEvents'>,
): FeaturePhaseToolHost {
  return new DefaultFeaturePhaseToolHost(featureId, graph, store);
}

function readEventPhase(event: EventRecord): AgentRun['phase'] | undefined {
  const phase = event.payload?.phase;
  switch (phase) {
    case 'execute':
    case 'discuss':
    case 'research':
    case 'plan':
    case 'feature_ci':
    case 'verify':
    case 'summarize':
    case 'replan':
      return phase;
    default:
      return undefined;
  }
}
