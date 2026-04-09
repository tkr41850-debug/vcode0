export interface Component {
  render(width: number): string[];
  invalidate(): void;
}

export class DagView implements Component {
  render(_width: number): string[] {
    return [];
  }

  invalidate(): void {}
}

export class StatusBar implements Component {
  render(_width: number): string[] {
    return [];
  }

  invalidate(): void {}
}

export class AgentMonitorOverlay implements Component {
  render(_width: number): string[] {
    return [];
  }

  invalidate(): void {}
}
