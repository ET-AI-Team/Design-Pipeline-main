import type { StageDefinition } from './types';

const registry = new Map<string, StageDefinition>();

/** Called once per stage, at server startup, by each file in src/stages/. */
export function registerStage(definition: StageDefinition): void {
  if (registry.has(definition.name)) {
    throw new Error(`Stage "${definition.name}" is already registered - duplicate registration is a bug.`);
  }
  registry.set(definition.name, definition);
}

export function getStageDefinition(name: string): StageDefinition {
  const def = registry.get(name);
  if (!def) {
    throw new Error(`No stage registered under name "${name}". Did src/stages/index.ts import it?`);
  }
  return def;
}

export function listRegisteredStages(): string[] {
  return Array.from(registry.keys());
}

/**
 * TEST ONLY. Removes a stage from the registry.
 *
 * The registry is process-global and `registerStage` throws on a
 * duplicate name, so a test that registers a fake stage has to be able
 * to take it back out again - otherwise the fake leaks into every other
 * test file sharing the process.
 *
 * That leak was real, not theoretical: four test files registered fakes
 * and never removed them, so `stages/index.test.ts` - which asserts the
 * registry's EXACT contents - saw 10 stages instead of 7 and failed. It
 * passed locally purely because bun happened to run that file before
 * the polluting ones, and failed the moment CI chose a different order.
 *
 * Deliberately not exported from `stages/index.ts`: production code has
 * no business unregistering a stage mid-flight.
 */
export function unregisterStageForTest(name: string): void {
  registry.delete(name);
}
