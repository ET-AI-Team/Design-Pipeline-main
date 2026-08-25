import { describe, it, expect } from 'bun:test';
import { CreateJobSchema, ListJobsQuerySchema } from './job.schema';

describe('CreateJobSchema', () => {
  it('accepts a valid prompt', () => {
    const result = CreateJobSchema.safeParse({ prompt: 'a valid prompt over ten characters' });
    expect(result.success).toBe(true);
  });

  it('rejects a prompt shorter than 10 characters', () => {
    const result = CreateJobSchema.safeParse({ prompt: 'too short' });
    expect(result.success).toBe(false);
  });

  it('rejects a prompt over 2000 characters', () => {
    const result = CreateJobSchema.safeParse({ prompt: 'a'.repeat(2001) });
    expect(result.success).toBe(false);
  });
});

describe('ListJobsQuerySchema', () => {
  it('applies defaults when no query params are given', () => {
    const result = ListJobsQuerySchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it('rejects an out-of-range limit', () => {
    const result = ListJobsQuerySchema.safeParse({ limit: '500' });
    expect(result.success).toBe(false);
  });
});
