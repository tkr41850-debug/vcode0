export type TuiCommandName =
  | 'new_plan'
  | 'add_milestone'
  | 'queue_milestone'
  | 'toggle_auto'
  | 'select_worker'
  | 'steer_worker'
  | 'retry_task'
  | 'answer_help'
  | 'toggle_agent_monitor'
  | 'replan_feature'
  | 'release_to_scheduler'
  | 'cancel_feature'
  | 'edit_feature'
  | 'show_feature_dependencies'
  | 'regenerate_codebase';

export interface TuiCommand {
  name: TuiCommandName;
  execute(): Promise<void>;
}

export class CommandRegistry {
  constructor(private readonly commands: TuiCommand[] = []) {}

  getAll(): TuiCommand[] {
    return [...this.commands];
  }
}
