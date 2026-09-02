import { z } from 'zod';
import { DIMENSION_NAMES } from '../enums';

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

/** POST /jobs/:id/edit targets either the 1:1 poster or one specific
 *  dimension - a plain enum of 'poster' plus the existing
 *  DIMENSION_NAMES, reused rather than duplicated. */
export const EDIT_TARGETS = ['poster', ...DIMENSION_NAMES] as const;
export type EditTarget = (typeof EDIT_TARGETS)[number];

/** POST /jobs/:id/edit - a free-text "improve this" request.
 *
 *  Rewritten 2026-09-02: a poster edit is no longer a whole-image
 *  regeneration from the previous poster. The instruction is routed to a
 *  copy/style/pixel lane, translated into a structured patch against the
 *  poster's stored spec, and re-rendered from Job.baseAssetUrl via
 *  gpt-image-2 - so repeated edits accumulate in the DATA while every
 *  image stays exactly one generation from clean. Non-poster targets
 *  (a dimension has no spec of its own) still take a whole-canvas edit.
 *
 *  Still deliberately outside the automated pipeline: a verification
 *  pass runs and is recorded, but never gates or retries - the human
 *  reading the result IS the QA. Every edit is now recorded in an
 *  AssetEdit row (lane, patch, resulting spec, verification verdict),
 *  so there IS version history, and the response reports which lane
 *  handled it plus whether existing dimensions are now stale.
 *
 *  This schema covers only the two TEXT fields; the up-to-4 optional
 *  `referenceImages` file parts are validated in the route by multer +
 *  assertOptionalFile, not here. */
export const EditAssetSchema = z.object({
  target: z.enum(EDIT_TARGETS),
  instruction: z.string().trim().min(3).max(500),
});
export type EditAssetInput = z.infer<typeof EditAssetSchema>;
