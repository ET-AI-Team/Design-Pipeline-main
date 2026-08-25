import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { ApiError } from '../lib/api-error';

type Source = 'body' | 'query' | 'params';

/**
 * Generic validation middleware factory. Every route in this app
 * validates through this one function - never a bespoke if/else
 * chain per route. On failure, throws an ApiError the error handler
 * (7.4) converts into the standard VALIDATION_ERROR envelope.
 */
export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      next(
        new ApiError(
          'VALIDATION_ERROR',
          400,
          firstIssue?.message ?? 'Validation failed',
          { field: firstIssue?.path.join('.') }
        )
      );
      return;
    }
    (req as any)[`validated${source[0]!.toUpperCase()}${source.slice(1)}`] = result.data;
    next();
  };
}
