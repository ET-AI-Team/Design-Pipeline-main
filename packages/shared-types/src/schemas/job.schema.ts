import { z } from 'zod';

/** POST /jobs - API Contract §3. File fields are validated separately by
 *  multer (size/type) before this schema checks the text field. */
export const CreateJobSchema = z.object({
  prompt: z.string().min(10).max(2000),
});
export type CreateJobInput = z.infer<typeof CreateJobSchema>;

export const ACCEPTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ACCEPTED_LOGO_MIME_TYPES = ['image/png', 'image/svg+xml'] as const;
export const MAX_REFERENCE_FILE_BYTES = 15 * 1024 * 1024; // 15 MB, API Contract §3
export const MAX_LOGO_FILE_BYTES = 5 * 1024 * 1024; // 5 MB, API Contract §3

/** PATCH /jobs/:id - renames a job's display name. */
export const RenameJobSchema = z.object({
  name: z.string().trim().min(1).max(140),
});
export type RenameJobInput = z.infer<typeof RenameJobSchema>;

/** GET /jobs query params - API Contract §4. */
export const ListJobsQuerySchema = z.object({
  status: z
    .enum([
      'QUEUED', 'BASE_LAYER_CLASSIFYING', 'BASE_ASSET_GENERATING', 'BASE_ASSET_SCORING', 'LOGO_PLACEMENT_DETECTING',
      'LOGO_COMPOSITING', 'POSTER_GENERATING', 'POSTER_SCORING', 'AWAITING_APPROVAL',
      'DIMENSION_EXPANDING', 'COMPLETE', 'NEEDS_ATTENTION', 'REJECTED',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;
