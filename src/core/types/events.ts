export interface EventRecord {
  eventType: string;
  entityId: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}
