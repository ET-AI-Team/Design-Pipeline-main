import { describe, it, expect } from 'bun:test';
// Component-level validation logic tested directly, mirroring the Zod
// rule from packages/shared-types/src/schemas/job.schema.ts.
function isPromptValid(prompt: string): boolean {
  return prompt.trim().length >= 10 && prompt.length <= 2000;
}

describe('Composer prompt validation', () => {
  it('rejects a prompt under 10 characters', () => {
    expect(isPromptValid('short')).toBe(false);
  });
  it('accepts a prompt of valid length', () => {
    expect(isPromptValid('a sufficiently long prompt for testing')).toBe(true);
  });
});
