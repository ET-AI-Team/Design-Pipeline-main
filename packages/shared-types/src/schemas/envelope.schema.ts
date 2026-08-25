import { z } from 'zod';

/** Standard success/error envelopes - API Contract §2. Every response
 *  in the system is shaped by one of these two, never ad hoc. */
export function successEnvelope<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({ data: dataSchema });
}

export const ErrorCode = z.enum([
  'VALIDATION_ERROR',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FILE_TYPE',
  'JOB_NOT_FOUND',
  'INVALID_STATE_TRANSITION',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
