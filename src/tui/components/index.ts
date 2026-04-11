export interface Component {
  render(width: number): string[];
  invalidate(): void;
}

export class DagView implements Component {
  private dirty = true;

  render(_width: number): string[] {
    this.dirty = false;
    return ['[DAG]'];
  }

  invalidate(): void {
    this.dirty = true;
  }
}

export class StatusBar implements Component {
  private dirty = true;

  render(_width: number): string[] {
    this.dirty = false;
    return ['[Status]'];
  }

  invalidate(): void {
    this.dirty = true;
  }
}

export class AgentMonitorOverlay implements Component {
  render(_width: number): string[] {
    return [];
  }

  invalidate(): void {}
}
