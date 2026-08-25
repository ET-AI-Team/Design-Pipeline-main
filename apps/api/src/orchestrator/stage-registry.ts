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
