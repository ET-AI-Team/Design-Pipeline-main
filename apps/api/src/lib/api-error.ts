import type { ErrorCode } from '@pipeline/shared-types';

/**
 * The only error type route handlers should throw. Never throw a raw
 * Error from inside a route - the error handler (7.4) only knows how
 * to translate ApiError into the standard envelope from API Contract §2.
 */
export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    public httpStatus: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
