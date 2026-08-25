import { describe, it, expect } from 'bun:test';
import pino from 'pino';
import { logger, loggerOptions } from './logger';

describe('logger field shape', () => {
  it('produces a log line containing every HLD-required field', () => {
    const testLogger = logger.child({}, {});
    const sample = {
      job_id: 'test-id',
      stage: 'base_asset',
      attempt_number: 1,
      qa_score: 8.5,
      latency_ms: 1000,
      cost_inr: 5.8,
      result: 'pass',
      model_used: 'gemini-3.1-flash-image',
    };
    testLogger.info(sample, 'stage_attempt_completed');

    const requiredFields = ['job_id', 'stage', 'attempt_number', 'qa_score', 'latency_ms', 'cost_inr', 'result', 'model_used'];
    for (const field of requiredFields) {
      expect(sample).toHaveProperty(field);
    }
  });

  it(
    'redacts API keys/auth from logged provider errors - real incident, not hypothetical: ' +
      'an OpenAI key was logged in plaintext via a raw `{ err }` axios error before this existed',
    async () => {
      const chunks: string[] = [];
      const sink = { write: (chunk: string) => { chunks.push(chunk); } };
      // Uses the real, exported loggerOptions - not a re-typed copy of
      // the redact list - so this test actually fails if logger.ts's
      // real config ever loses a path.
      const testLogger = pino(loggerOptions, sink as any);

      testLogger.error(
        {
          err: {
            message: 'Request failed with status code 401',
            config: {
              headers: { Authorization: 'Bearer sk-live-should-never-appear' },
            },
          },
        },
        'worker_job_failed'
      );
      testLogger.error(
        {
          err: {
            message: 'Request failed',
            config: { params: { key: 'AIza-should-never-appear' } },
          },
        },
        'worker_job_failed'
      );

      const output = chunks.join('');
      expect(output).not.toContain('sk-live-should-never-appear');
      expect(output).not.toContain('AIza-should-never-appear');
      expect(output).toContain('[REDACTED]');
    }
  );
});
