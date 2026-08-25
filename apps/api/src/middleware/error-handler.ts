import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../lib/api-error';
import { logger } from '../lib/logger';

/** The one place ApiError (and anything unexpected) becomes an HTTP
 *  response, per API Contract §2's standard error envelope. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  logger.error({ err, path: req.path }, 'unhandled_error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server-side failure occurred' } });
}
