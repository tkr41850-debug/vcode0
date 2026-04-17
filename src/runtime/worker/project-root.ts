export function resolveWorkerProjectRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return env.GVC0_PROJECT_ROOT ?? cwd;
}
