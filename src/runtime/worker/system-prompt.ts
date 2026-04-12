import type { Task } from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';

/**
 * Build the system prompt handed to the pi-sdk `Agent` for a task run.
 *
 * Lives in the runtime layer because it is assembled from runtime-owned
 * `WorkerContext` inputs (plan summary, dependency outputs, codebase map,
 * knowledge, decisions) and submitted directly to the harness. The worker
 * agent's tool catalog lives under `@agents/worker`.
 */
export function buildSystemPrompt(task: Task, context: WorkerContext): string {
  const parts: string[] = [];

  parts.push(
    `You are a task worker executing task ${task.id}: ${task.description}`,
  );

  if (context.planSummary !== undefined) {
    parts.push(`\n## Plan\n${context.planSummary}`);
  }

  if (
    context.dependencyOutputs !== undefined &&
    context.dependencyOutputs.length > 0
  ) {
    parts.push('\n## Dependency Outputs');
    for (const dep of context.dependencyOutputs) {
      parts.push(`- ${dep.taskId} (${dep.featureName}): ${dep.summary}`);
    }
  }

  if (context.codebaseMap !== undefined) {
    parts.push(`\n## Codebase\n${context.codebaseMap}`);
  }

  if (context.knowledge !== undefined) {
    parts.push(`\n## Knowledge\n${context.knowledge}`);
  }

  if (context.decisions !== undefined) {
    parts.push(`\n## Decisions\n${context.decisions}`);
  }

  return parts.join('\n');
}
