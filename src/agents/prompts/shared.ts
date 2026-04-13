import type { Feature, FeaturePhaseRunContext } from '@core/types/index';

export type PromptRenderInput = Record<string, unknown>;

type UnknownRecord = Record<string, unknown>;

type FeatureLike = Partial<
  Pick<
    Feature,
    | 'id'
    | 'name'
    | 'description'
    | 'status'
    | 'workControl'
    | 'collabControl'
    | 'featureBranch'
    | 'dependsOn'
  >
>;

type RunLike = Partial<
  Pick<FeaturePhaseRunContext, 'agentRunId' | 'sessionId'>
>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function getString(
  input: PromptRenderInput,
  key: string,
): string | undefined {
  return asString(input[key]);
}

export function getStringArray(
  input: PromptRenderInput,
  key: string,
): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);

  return items.length > 0 ? items : undefined;
}

export function joinSections(...sections: Array<string | undefined>): string {
  return sections.filter(nonEmpty).join('\n\n');
}

export function renderSection(
  title: string,
  body: string | undefined,
): string | undefined {
  if (!nonEmpty(body)) {
    return undefined;
  }

  return `## ${title}\n${body}`;
}

export function renderLabeledBlock(
  label: string,
  body: string | undefined,
): string | undefined {
  if (!nonEmpty(body)) {
    return undefined;
  }

  return `### ${label}\n${body}`;
}

export function renderBlockSection(
  title: string,
  blocks: Array<string | undefined>,
): string | undefined {
  const body = blocks.filter(nonEmpty).join('\n\n');
  return renderSection(title, body.length > 0 ? body : undefined);
}

export function renderList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

export function renderListSection(
  title: string,
  items: string[] | undefined,
): string | undefined {
  if (items === undefined || items.length === 0) {
    return undefined;
  }

  return renderSection(title, renderList(items));
}

function readFeature(input: PromptRenderInput): FeatureLike | undefined {
  const feature = asRecord(input.feature);
  if (feature === undefined) {
    return undefined;
  }

  return feature as FeatureLike;
}

function readRun(input: PromptRenderInput): RunLike | undefined {
  const run = asRecord(input.run);
  if (run === undefined) {
    return undefined;
  }

  return run as RunLike;
}

export function renderFeatureSection(
  input: PromptRenderInput,
): string | undefined {
  const feature = readFeature(input);
  const dependsOn = feature?.dependsOn ?? getStringArray(input, 'dependsOn');

  const lines = [
    asString(feature?.id) ?? getString(input, 'featureId'),
    asString(feature?.name) ?? getString(input, 'featureName'),
    asString(feature?.description) ?? getString(input, 'featureDescription'),
    asString(feature?.status) ?? getString(input, 'featureStatus'),
    asString(feature?.workControl) ?? getString(input, 'workControl'),
    asString(feature?.collabControl) ?? getString(input, 'collabControl'),
    asString(feature?.featureBranch) ?? getString(input, 'featureBranch'),
  ];

  const bullets = [
    lines[0] !== undefined ? `ID: ${lines[0]}` : undefined,
    lines[1] !== undefined ? `Name: ${lines[1]}` : undefined,
    lines[2] !== undefined ? `Description: ${lines[2]}` : undefined,
    lines[3] !== undefined ? `Status: ${lines[3]}` : undefined,
    lines[4] !== undefined ? `Work control: ${lines[4]}` : undefined,
    lines[5] !== undefined ? `Collaboration: ${lines[5]}` : undefined,
    lines[6] !== undefined ? `Branch: ${lines[6]}` : undefined,
    dependsOn !== undefined && dependsOn.length > 0
      ? `Depends on: ${dependsOn.join(', ')}`
      : undefined,
  ].filter(nonEmpty);

  return bullets.length > 0
    ? renderSection('Feature', renderList(bullets))
    : undefined;
}

export function renderRunSection(input: PromptRenderInput): string | undefined {
  const run = readRun(input);
  const agentRunId =
    asString(run?.agentRunId) ?? getString(input, 'agentRunId');
  const sessionId = asString(run?.sessionId) ?? getString(input, 'sessionId');

  const bullets = [
    agentRunId !== undefined ? `Agent run: ${agentRunId}` : undefined,
    sessionId !== undefined ? `Session: ${sessionId}` : undefined,
  ].filter(nonEmpty);

  return bullets.length > 0
    ? renderSection('Run Context', renderList(bullets))
    : undefined;
}
