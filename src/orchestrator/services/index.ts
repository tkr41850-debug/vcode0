import type {
  BudgetAction,
  Feature,
  VerificationSummary,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { ModelRouter } from '@runtime/routing/index';

export class RecoveryService {
  constructor(private readonly ports: OrchestratorPorts) {}

  async recoverOrphanedRuns(): Promise<void> {
    const state = await this.ports.store.loadRecoveryState();

    for (const run of state.agentRuns) {
      if (run.runStatus === 'running') {
        await this.ports.store.updateAgentRun(run.id, {
          runStatus: 'failed',
        });
      }
    }
  }
}

export class VerificationService {
  constructor(private readonly ports: OrchestratorPorts) {}

  verifyFeature(_feature: Feature): Promise<VerificationSummary> {
    const featureConfig = this.ports.config.verification?.feature;
    if (!featureConfig) {
      return Promise.resolve({ ok: true });
    }

    const failedChecks: string[] = [];
    for (const check of featureConfig.checks) {
      // In a real implementation, this would exec the command.
      // For now, any configured check is treated as failed since we
      // cannot execute shell commands from this service layer.
      failedChecks.push(check.description);

      if (!featureConfig.continueOnFail) {
        break;
      }
    }

    if (failedChecks.length > 0) {
      return Promise.resolve({ ok: false, failedChecks });
    }

    return Promise.resolve({ ok: true });
  }
}

export class BudgetService {
  private readonly router = new ModelRouter();
  private action: BudgetAction = 'ok';

  constructor(private readonly ports: OrchestratorPorts) {}

  async refresh(): Promise<void> {
    const budgetConfig = this.ports.config.budget;
    if (!budgetConfig) {
      this.action = 'ok';
      return;
    }

    const runs = await this.ports.store.listAgentRuns();
    const totalUsd = 0;
    const perTaskUsd: Record<string, number> = {};

    for (const run of runs) {
      if (run.scopeType === 'task') {
        const current = perTaskUsd[run.scopeId] ?? 0;
        perTaskUsd[run.scopeId] = current;
      }
    }

    this.action = this.router.checkBudget(
      { totalUsd, totalCalls: runs.length, perTaskUsd },
      budgetConfig,
    );
  }

  currentAction(): BudgetAction {
    return this.action;
  }
}
