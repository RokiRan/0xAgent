// ============================================================
// Core: Service Registry
// Plugins register services here; other plugins consume them.
// ============================================================

export class ServiceRegistry {
  private services = new Map<string, unknown>();

  register<T>(name: string, service: T): void {
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" already registered`);
    }
    this.services.set(name, service);
  }

  get<T>(name: string): T {
    if (!this.services.has(name)) {
      throw new Error(`Service "${name}" not found`);
    }
    return this.services.get(name) as T;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  unregister(name: string): void {
    this.services.delete(name);
  }

  list(): string[] {
    return Array.from(this.services.keys());
  }
}
