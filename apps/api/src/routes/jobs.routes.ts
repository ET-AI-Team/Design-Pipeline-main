import { Router } from 'express';
import multer from 'multer';
import {
  CreateJobSchema,
  RenameJobSchema,
  ListJobsQuerySchema,
  ACCEPTED_IMAGE_MIME_TYPES,
  ACCEPTED_LOGO_MIME_TYPES,
  MAX_REFERENCE_FILE_BYTES,
  MAX_LOGO_FILE_BYTES,
} from '@pipeline/shared-types';
import { db } from '../lib/db';
import { validate } from '../middleware/validate';
import { ApiError } from '../lib/api-error';
import { uploadToCloudinary } from '../providers/cloudinary.client';
import { dispatchStageJob } from '../queues/dispatch';
import { retryStuckJob } from '../orchestrator/retry-stuck-job';
import { deleteJob } from '../orchestrator/delete-job';
import { emitJobCreated } from '../realtime/emitters';
import { approveJob, rejectJob } from '../realtime/approval-handler';
import { getStageDefinition } from '../orchestrator/stage-registry';

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

      const [ref1Upload, ref2Upload, logoUpload] = await Promise.all([
        uploadToCloudinary(reference1.buffer, { folder: 'references' }),
        uploadToCloudinary(reference2.buffer, { folder: 'references' }),
        uploadToCloudinary(logo.buffer, { folder: 'logos' }),
      ]);

      const job = await db.job.create({
        data: {
          reference1Url: ref1Upload.secureUrl,
          reference2Url: ref2Upload.secureUrl,
          logoUrl: logoUpload.secureUrl,
          prompt,
          status: 'BASE_LAYER_CLASSIFYING',
        },
      });

      emitJobCreated(job.id, job.createdAt.toISOString());

      // base_layer_classification now runs first (its nextStageOnPass is
      // 'base_asset') - base_asset's buildPrompt depends on
      // job.baseLayerSpecJson being populated, which only happens once
      // this stage passes.
      const classificationStage = getStageDefinition('base_layer_classification');
      await dispatchStageJob({
        jobId: job.id,
        stage: 'base_layer_classification',
        attemptNumber: 1,
        prompt: classificationStage.buildPrompt(job),
        inputAssetUrl: classificationStage.getInputAssetUrl(job),
      });

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
