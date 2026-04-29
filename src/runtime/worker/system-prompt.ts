import type { Task } from '@core/types/index';
import type { TaskPayload } from '@runtime/context/index';

const EXECUTE_TASK_PROMPT = `You are gvc0 task execution agent.

Task plan is authoritative contract for what must be built and verified, but local code reality wins over stale assumptions.
Verify referenced files and surrounding code before changing anything.
Do not do broad re-research or spontaneous re-planning.
Minor local adaptation is allowed. Fundamental plan invalidation is blocker.

Execution rules:
- follow task contract closely
- build real behavior, not fake success paths
- write or update tests as part of implementation
- preserve or add observability for non-trivial runtime changes
- verify must-haves with concrete checks
- summarize exactly what changed and what evidence passed

Debugging rules:
- form hypothesis before fixing
- change one variable at a time
- read full relevant functions and imports
- distinguish facts from assumptions
- if the same test or check fails 3 times in a row, stop tool use and write a numbered list of every assumption underlying the current approach, marking each as confirmed-by-evidence or assumed; restart from the highest-uncertainty assumption rather than continuing the same fix path

Blocker rules:
- ordinary bugs or local mismatches are not blockers
- blocker means remaining plan no longer holds because of missing capability, wrong seam, invalid assumption, or architectural mismatch
- when blocker found, explain it clearly for downstream replan

Output should include:
- what was implemented
- files changed
- verification evidence
- decisions or knowledge worth carrying forward
- blocker summary if plan was invalidated

Do not:
- reopen architecture without evidence
- broaden scope because nearby work looks tempting
- skip verification because change seems obvious`;

function renderSection(
  title: string,
  body: string | undefined,
): string | undefined {
  if (body === undefined || body.trim().length === 0) {
    return undefined;
  }

  return `## ${title}\n${body}`;
}

function renderListSection(
  title: string,
  items: readonly string[] | undefined,
): string | undefined {
  if (items === undefined || items.length === 0) {
    return undefined;
  }

  return `## ${title}\n${items.map((item) => `- ${item}`).join('\n')}`;
}

function renderTaskSection(task: Task): string {
  const bullets = [
    `- ID: ${task.id}`,
    `- Feature: ${task.featureId}`,
    `- Description: ${task.description}`,
    `- Status: ${task.status}`,
    `- Collaboration: ${task.collabControl}`,
  ];

  if (task.weight !== undefined) {
    bullets.push(`- Weight: ${task.weight}`);
  }

  if (task.taskTestPolicy !== undefined) {
    bullets.push(`- Test policy: ${task.taskTestPolicy}`);
  }

  if (
    task.reservedWritePaths !== undefined &&
    task.reservedWritePaths.length > 0
  ) {
    bullets.push(
      `- Reserved write paths: ${task.reservedWritePaths.join(', ')}`,
    );
  }

  return `## Task\n${bullets.join('\n')}`;
}

function renderDependencyOutputs(payload: TaskPayload): string | undefined {
  if (
    payload.dependencyOutputs === undefined ||
    payload.dependencyOutputs.length === 0
  ) {
    return undefined;
  }

  const lines = payload.dependencyOutputs.map((dep) => {
    const files =
      dep.filesChanged.length > 0
        ? `\n  Files: ${dep.filesChanged.join(', ')}`
        : '';
    return `- ${dep.taskId} (${dep.featureName}): ${dep.summary}${files}`;
  });

  return renderSection('Dependency Outputs', lines.join('\n'));
}

/**
 * Build system prompt handed to pi-sdk `Agent` for task run.
 *
 * Consumes planner-baked `TaskPayload` (task objective/scope/refs/
 * expectedFiles/outcomeVerification + feature objective/DoD + plan
 * summary + dependency outputs). Every field is persisted on the Task
 * or Feature row — no runtime heuristics, no event mining.
 */
export function buildSystemPrompt(task: Task, payload: TaskPayload): string {
  return [
    EXECUTE_TASK_PROMPT,
    renderTaskSection(task),
    renderSection('Task Objective', payload.objective),
    renderSection('Scope', payload.scope),
    renderListSection('Expected Files', payload.expectedFiles),
    renderListSection('References', payload.references),
    renderSection('Outcome Verification', payload.outcomeVerification),
    renderSection('Feature Objective', payload.featureObjective),
    renderListSection('Feature Definition of Done', payload.featureDoD),
    renderSection('Plan', payload.planSummary),
    renderDependencyOutputs(payload),
  ]
    .filter((section): section is string => section !== undefined)
    .join('\n\n');
}
