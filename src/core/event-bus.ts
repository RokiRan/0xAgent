// ============================================================
// Core: Event Bus
// A lightweight pub/sub system for inter-plugin communication.
// ============================================================

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on<T>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);
    return () => this.handlers.get(event)?.delete(handler as EventHandler);
  }

  emit<T>(event: string, payload: T): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        const result = h(payload);
        if (result instanceof Promise) {
          result.catch(err => console.error(`Event handler error on ${event}:`, err));
        }
      } catch (err) {
        console.error(`Event handler error on ${event}:`, err);
      }
    }
  }
}
