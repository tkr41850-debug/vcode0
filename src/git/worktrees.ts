import type { Feature, Task } from '@core/types/index';

export class TaskWorktreeManager {
  createTaskWorktree(_task: Task, _feature: Feature): Promise<string> {
    return Promise.resolve('');
  }

  mergeTaskWorktree(
    _task: Task,
    _result: { summary: string; filesChanged: string[] },
  ): Promise<void> {
    return Promise.resolve();
  }
}
