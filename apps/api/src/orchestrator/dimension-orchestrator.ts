import type { Job } from '@prisma/client';
import { DIMENSION_NAMES } from '@pipeline/shared-types';
import { db } from '../lib/db';
import { ApiError } from '../lib/api-error';
import { logger } from '../lib/logger';
import { dispatchStageJob } from '../queues/dispatch';
import { getStageDefinition } from './stage-registry';
import { emitJobCompleted, emitStatusChanged } from '../realtime/emitters';

/**
 * Re-runs all three dimension expansions against the CURRENT poster.
 * Needed after a poster edit, since the existing dimensions were
 * recomposed from the poster that edit replaced.
 *
 * RESETS the existing DimensionJob rows rather than creating new ones.
 * That distinction is load-bearing: onApproved() below does
 * dimensionJob.create(), and there is no unique constraint on
 * (jobId, dimension), so simply calling it again would silently leave
 * the job with two sets of three dimension rows and a dashboard showing
 * six. Their stage attempts are deleted too, so dispatch at attempt 1
 * isn't swallowed by the (jobId, stage, attemptNumber) idempotency guard
 * - the same reason retryStuckJob() deletes before redispatching.
 */
export async function regenerateDimensions(jobId: string): Promise<Job> {
  const job = await db.job.findFirst({ where: { id: jobId, deletedAt: null } });
  if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `No job with id ${jobId}`);
  if (!job.posterUrl) {
    throw new ApiError('INVALID_STATE_TRANSITION', 409, 'This job has no approved poster to expand yet', {
      currentStatus: job.status,
    });
  }

  const existing = await db.dimensionJob.findMany({ where: { jobId } });
  if (existing.length === 0) {
    throw new ApiError('INVALID_STATE_TRANSITION', 409, 'This job has no dimensions to regenerate - approve it first', {
      currentStatus: job.status,
    });
  }

  logger.info({ job_id: jobId, dimensions: existing.length }, 'regenerating_dimensions');

  await db.job.update({ where: { id: jobId }, data: { status: 'DIMENSION_EXPANDING' } });
  emitStatusChanged(jobId, 'DIMENSION_EXPANDING');

  await Promise.all(
    DIMENSION_NAMES.map(async (dimension) => {
      const stageName = `dimension_${dimension}`;
      await db.stageAttempt.deleteMany({ where: { jobId, stage: stageName } });
      await db.dimensionJob.updateMany({
        where: { jobId, dimension },
        data: { status: 'PENDING', assetUrl: null },
      });

      const stageDef = getStageDefinition(stageName);
      // Re-read the job so getInputAssetUrl() picks up the CURRENT
      // posterUrl - the whole point of regenerating.
      const fresh = await db.job.findUniqueOrThrow({ where: { id: jobId } });
      await dispatchStageJob({
        jobId,
        stage: stageName,
        attemptNumber: 1,
        prompt: stageDef.buildPrompt(fresh),
        inputAssetUrl: stageDef.getInputAssetUrl(fresh),
      });
    })
  );

  return db.job.findUniqueOrThrow({ where: { id: jobId } });
}

/** Called once, when a human approves a job. Dispatches all three
 *  dimensions in parallel - genuinely concurrent, not sequential. */
export async function onApproved(job: Job): Promise<void> {
  await Promise.all(
    DIMENSION_NAMES.map(async (dimension) => {
      await db.dimensionJob.create({ data: { jobId: job.id, dimension, status: 'PENDING' } });

      const stageName = `dimension_${dimension}`;
      const stageDef = getStageDefinition(stageName);

      await dispatchStageJob({
        jobId: job.id,
        stage: stageName,
        attemptNumber: 1,
        prompt: stageDef.buildPrompt(job),
        inputAssetUrl: stageDef.getInputAssetUrl(job),
      });
    })
  );
}

/** Called after every dimension's stage attempt resolves. The parent
 *  Job only moves to COMPLETE once every dimension child has reached
 *  a terminal state - DELIVERED or NEEDS_ATTENTION - per LLD §2.2's
 *  partial-delivery requirement: one dimension failing never blocks
 *  the other two from completing. */
export async function checkForCompletion(jobId: string): Promise<void> {
  const children = await db.dimensionJob.findMany({ where: { jobId } });
  const allTerminal = children.every((d) => d.status === 'DELIVERED' || d.status === 'NEEDS_ATTENTION');

  if (!allTerminal) return;

  await db.job.update({ where: { id: jobId }, data: { status: 'COMPLETE' } });

  const delivered = children
    .filter((d) => d.status === 'DELIVERED' && d.assetUrl)
    .map((d) => ({ dimension: d.dimension, assetUrl: d.assetUrl! }));

  emitJobCompleted(jobId, delivered);
}
