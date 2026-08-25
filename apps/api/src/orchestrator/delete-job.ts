import { db } from '../lib/db';
import { ApiError } from '../lib/api-error';
import { logger } from '../lib/logger';
import { deleteFromCloudinary } from '../providers/cloudinary.client';
import { emitJobDeleted } from '../realtime/emitters';

/**
 * Deleting a job soft-deletes the Job row (same `deletedAt` convention
 * every list/lookup query already filters on - see jobs.routes.ts,
 * retry-stuck-job.ts) but HARD-deletes every real Cloudinary asset the
 * job produced or was given: both references, the logo, every
 * StageAttempt's asset (including failed/retried attempts, not just the
 * one that ended up linked to the Job row), and every dimension asset.
 * Soft-deleting the DB row keeps cost/audit history intact and is
 * reversible; the Cloudinary assets are real storage cost with no
 * reason to keep once the user has deleted the job, and once destroyed
 * are NOT recoverable - this is the one genuinely irreversible part of
 * "delete."
 *
 * Best-effort on the Cloudinary side: one bad/already-gone URL doesn't
 * block the rest from being cleaned up or block the job itself from
 * being marked deleted - a partial cleanup failure shouldn't leave the
 * job stuck undeletable in the UI.
 */
export async function deleteJob(jobId: string): Promise<void> {
  const job = await db.job.findFirst({
    where: { id: jobId, deletedAt: null },
    include: { stageAttempts: true, dimensionJobs: true },
  });
  if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `No job with id ${jobId}`);

  const urls = new Set<string>([job.reference1Url, job.reference2Url, job.logoUrl]);
  if (job.baseAssetUrl) urls.add(job.baseAssetUrl);
  if (job.posterUrl) urls.add(job.posterUrl);
  for (const attempt of job.stageAttempts) if (attempt.assetUrl) urls.add(attempt.assetUrl);
  for (const dimension of job.dimensionJobs) if (dimension.assetUrl) urls.add(dimension.assetUrl);

  const results = await Promise.allSettled([...urls].map((url) => deleteFromCloudinary(url)));
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn({ job_id: jobId, err: result.reason }, 'cloudinary_asset_delete_failed');
    }
  }

  await db.job.update({ where: { id: jobId }, data: { deletedAt: new Date() } });
  emitJobDeleted(jobId);
}
