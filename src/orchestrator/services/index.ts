import type { Feature, VerificationSummary } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class RecoveryService {
  constructor(private readonly ports: OrchestratorPorts) {}

  recoverOrphanedRuns(): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }
}

export class VerificationService {
  constructor(private readonly ports: OrchestratorPorts) {}

  verifyFeature(_feature: Feature): Promise<VerificationSummary> {
    void this.ports;
    return Promise.resolve({ ok: true });
  }
}

export class BudgetService {
  constructor(private readonly ports: OrchestratorPorts) {}

  refresh(): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }
}
