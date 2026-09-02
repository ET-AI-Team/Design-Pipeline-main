import { Router } from 'express';
import multer from 'multer';
import {
  CreateJobSchema,
  RenameJobSchema,
  ListJobsQuerySchema,
  EditAssetSchema,
  ACCEPTED_IMAGE_MIME_TYPES,
  ACCEPTED_LOGO_MIME_TYPES,
  MAX_REFERENCE_FILE_BYTES,
  MAX_LOGO_FILE_BYTES,
} from '@pipeline/shared-types';
import { db } from '../lib/db';
import { validate } from '../middleware/validate';
import { ApiError } from '../lib/api-error';
import { logger } from '../lib/logger';
import { retryStuckJob } from '../orchestrator/retry-stuck-job';
import { deleteJob } from '../orchestrator/delete-job';
import { editAsset } from '../orchestrator/edit-asset';
import { finalizeJobCreation } from '../orchestrator/finalize-job-creation';
import { emitJobCreated } from '../realtime/emitters';
import { approveJob, rejectJob } from '../realtime/approval-handler';

export const jobsRouter: Router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_REFERENCE_FILE_BYTES } });

function assertFile(
  file: Express.Multer.File | undefined,
  fieldName: string,
  acceptedTypes: readonly string[],
  maxBytes: number
): Express.Multer.File {
  if (!file) throw new ApiError('VALIDATION_ERROR', 400, `${fieldName} is required`, { field: fieldName });
  if (!acceptedTypes.includes(file.mimetype)) {
    throw new ApiError('UNSUPPORTED_FILE_TYPE', 415, `${fieldName} must be one of: ${acceptedTypes.join(', ')}`, { field: fieldName });
  }
  if (file.size > maxBytes) {
    throw new ApiError('FILE_TOO_LARGE', 413, `${fieldName} exceeds the ${maxBytes / (1024 * 1024)}MB limit`, { field: fieldName });
  }
  return file;
}

/** Same checks as assertFile(), but for a field that's allowed to be
 *  absent entirely - e.g. /edit's optional referenceImage. */
function assertOptionalFile(
  file: Express.Multer.File | undefined,
  fieldName: string,
  acceptedTypes: readonly string[],
  maxBytes: number
): Express.Multer.File | undefined {
  if (!file) return undefined;
  if (!acceptedTypes.includes(file.mimetype)) {
    throw new ApiError('UNSUPPORTED_FILE_TYPE', 415, `${fieldName} must be one of: ${acceptedTypes.join(', ')}`, { field: fieldName });
  }
  if (file.size > maxBytes) {
    throw new ApiError('FILE_TOO_LARGE', 413, `${fieldName} exceeds the ${maxBytes / (1024 * 1024)}MB limit`, { field: fieldName });
  }
  return file;
}

/** POST /api/v1/jobs - API Contract §3 */
jobsRouter.post(
  '/',
  upload.fields([
    { name: 'reference1', maxCount: 1 },
    { name: 'reference2', maxCount: 1 },
    { name: 'logo', maxCount: 1 },
  ]),
  validate(CreateJobSchema, 'body'),
  async (req, res, next) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]>;
      const reference1 = assertFile(files.reference1?.[0], 'reference1', ACCEPTED_IMAGE_MIME_TYPES, MAX_REFERENCE_FILE_BYTES);
      const reference2 = assertFile(files.reference2?.[0], 'reference2', ACCEPTED_IMAGE_MIME_TYPES, MAX_REFERENCE_FILE_BYTES);
      const logo = assertFile(files.logo?.[0], 'logo', ACCEPTED_LOGO_MIME_TYPES, MAX_LOGO_FILE_BYTES);
      const { prompt } = (req as any).validatedBody;

      // Row first, uploads after - see finalize-job-creation.ts for the
      // measured reason (three real Cloudinary uploads made this route
      // ~6.8s solo and 13-59s under a 30-concurrent burst). The URLs are
      // deliberately empty for the few seconds until the uploads land;
      // `status: QUEUED` is what actually carries "created, not started
      // yet" (the one JobStatus that was previously only ever a Prisma
      // default and never a real observed state), and every consumer
      // keys off status, not off the URL strings.
      const job = await db.job.create({
        data: {
          reference1Url: '',
          reference2Url: '',
          logoUrl: '',
          prompt,
          status: 'QUEUED',
        },
      });

      emitJobCreated(job.id, job.createdAt.toISOString());

      // Deliberately NOT awaited - this is the whole point of the split.
      // finalizeJobCreation owns its own failure handling (it can't throw
      // into an already-sent response), so a rejection here would only
      // ever be a bug in that handler itself.
      void finalizeJobCreation(job.id, {
        reference1: reference1.buffer,
        reference2: reference2.buffer,
        logo: logo.buffer,
      }).catch((err) => logger.error({ err, job_id: job.id }, 'finalize_job_creation_unhandled'));

      res.status(201).json({ data: { jobId: job.id, status: job.status, createdAt: job.createdAt.toISOString() } });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/jobs - API Contract §4 */
jobsRouter.get('/', validate(ListJobsQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { status, limit, offset } = (req as any).validatedQuery;
    const where = { deletedAt: null, ...(status ? { status } : {}) };

    const [jobs, total] = await Promise.all([
      db.job.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      db.job.count({ where }),
    ]);

    res.json({
      data: {
        jobs: jobs.map((j) => ({
          jobId: j.id,
          name: j.name,
          status: j.status,
          prompt: j.prompt,
          createdAt: j.createdAt.toISOString(),
          updatedAt: j.updatedAt.toISOString(),
        })),
        total,
        limit,
        offset,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/jobs/:id - API Contract §5 */
jobsRouter.get('/:id', async (req, res, next) => {
  try {
    const job = await db.job.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { stageAttempts: true, dimensionJobs: true, approvalLog: true },
    });
    if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `No job with id ${req.params.id}`);
    res.json({ data: job });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/jobs/:id/approve - API Contract §6 */
jobsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const job = await approveJob(req.params.id);
    res.json({ data: { jobId: job.id, status: job.status } });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/jobs/:id/reject - API Contract §7 */
jobsRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const job = await rejectJob(req.params.id);
    res.json({ data: { jobId: job.id, status: job.status } });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/jobs/:id/edit - "improve this" via Nano Banana Pro.
 *  Synchronous (a real Gemini call can take up to ~90s) - the new
 *  image replaces whatever was previously set for `target` outright,
 *  no version history. Takes an optional `referenceImage` file alongside
 *  the text instruction - e.g. "make the CTA look like this" - since a
 *  concrete visual reference transfers style far more reliably than
 *  prose alone (same reasoning poster-text-edit.ts's reference crops
 *  already rely on for the automated pipeline). */
jobsRouter.post(
  '/:id/edit',
  upload.single('referenceImage'),
  validate(EditAssetSchema, 'body'),
  async (req, res, next) => {
    try {
      const jobId = req.params.id!;
      const { target, instruction } = (req as any).validatedBody;
      const referenceImage = assertOptionalFile(req.file, 'referenceImage', ACCEPTED_IMAGE_MIME_TYPES, MAX_REFERENCE_FILE_BYTES);
      const result = await editAsset({ jobId, target, instruction, referenceImageBuffer: referenceImage?.buffer });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/jobs/:id/retry - API Contract §8, LLD §7.1 */
jobsRouter.post('/:id/retry', async (req, res, next) => {
  try {
    const job = await retryStuckJob(req.params.id);
    res.json({ data: { jobId: job.id, status: job.status } });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/jobs/:id - renames a job's display name. */
jobsRouter.patch('/:id', validate(RenameJobSchema, 'body'), async (req, res, next) => {
  try {
    const { name } = (req as any).validatedBody;
    const existing = await db.job.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!existing) throw new ApiError('JOB_NOT_FOUND', 404, `No job with id ${req.params.id}`);

    const job = await db.job.update({ where: { id: req.params.id }, data: { name } });
    res.json({ data: { jobId: job.id, name: job.name } });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/v1/jobs/:id - soft-deletes the job and hard-deletes every
 *  Cloudinary asset it owns (see delete-job.ts for why the split). */
jobsRouter.delete('/:id', async (req, res, next) => {
  try {
    await deleteJob(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
