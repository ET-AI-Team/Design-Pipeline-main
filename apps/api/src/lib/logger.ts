import pino from 'pino';

/**
 * One structured logger, imported everywhere a log line is needed.
 * Field names match the HLD monitoring table exactly:
 * job_id, stage, attempt_number, qa_score, latency_ms, cost_inr,
 * result, timestamp, model_used, human_decision - so log lines are
 * queryable without reparsing, per ADR-012's reasoning.
 */
// Exported separately (not inlined into the pino() call below) so
// logger.test.ts can construct the exact same configuration against a
// test sink, instead of duplicating this list in the test - a
// duplicated list would keep passing even if this one drifted or lost
// a path.
export const loggerOptions: pino.LoggerOptions = {
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: undefined, // omit pid/hostname noise in local dev logs
  // Real incident, not a hypothetical: an OpenAI 401 got logged with
  // `{ err }` (every logger.error call site in this codebase does this),
  // and axios errors carry the full failed request on `err.config`,
  // including the Authorization header and, for Gemini, the API key as
  // a query param (`?key=...`). That put a live key in plaintext in a
  // log file. Redacting at the logger level protects every call site at
  // once, present and future, rather than trusting each one to remember.
  redact: {
    paths: [
      'err.config.headers.Authorization',
      'err.config.headers.authorization',
      'err.config.params.key',
      'err.response.config.headers.Authorization',
      'err.response.config.headers.authorization',
      'err.response.config.params.key',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
};

/**
 * One structured logger, imported everywhere a log line is needed.
 * Field names match the HLD monitoring table exactly:
 * job_id, stage, attempt_number, qa_score, latency_ms, cost_inr,
 * result, timestamp, model_used, human_decision - so log lines are
 * queryable without reparsing, per ADR-012's reasoning.
 */
export const logger = pino(loggerOptions);
