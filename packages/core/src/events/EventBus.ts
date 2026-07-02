import type { AgentEvent } from "./AgentEvent.js";

export type EventHandler = (event: AgentEvent) => void;

export class EventBus {
  private handlers = new Set<EventHandler>();

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // don't let a bad handler break the event loop
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
