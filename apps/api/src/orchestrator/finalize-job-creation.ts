import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { Semaphore } from '../lib/semaphore';
import { uploadToCloudinary } from '../providers/cloudinary.client';
import { dispatchStageJob } from '../queues/dispatch';
import { getStageDefinition } from './stage-registry';
import { emitStatusChanged, emitNeedsAttention } from '../realtime/emitters';

export interface PendingJobUploads {
  reference1: Buffer;
  reference2: Buffer;
  /** Absent when the campaign has no brand mark to place. Everything
   *  downstream keys off Job.logoUrl being '' rather than off this. */
  logo?: Buffer;
}

/**
 * Measured reason this exists: making job creation non-blocking fixed
 * the HTTP response (6.8s -> ~1s, 30/30 submissions accepted in 4.8s
 * instead of 6/30 in 60s) but moved the pile-up rather than removing it.
 * A 30-job burst fired 30 finalizeJobCreation() calls at once, each
 * doing 3 parallel uploads - 90 simultaneous Cloudinary uploads
 * competing for the same finite bandwidth. Nothing errored; everything
 * just crawled, and 28/30 jobs were still sitting in QUEUED three
 * minutes later. Bounded here so a burst drains steadily, N jobs at a
 * time, instead of 30 jobs all finishing nowhere at once - it does not
 * make the total upload work faster (that's bandwidth-bound), it makes
 * completion ordered and predictable, and keeps peak memory down by not
 * holding every accepted job's file buffers in flight simultaneously.
 */
const uploadSemaphore = new Semaphore(Number(process.env.JOB_UPLOAD_CONCURRENCY ?? 4));

/**
 * The slow half of job creation, run in the BACKGROUND after the HTTP
 * response has already gone out.
 *
 * Measured reason this exists: POST /jobs used to await three real
 * Cloudinary uploads before it created the Job row or responded at all.
 * A single submission took ~6.8s end to end, and a 30-concurrent burst
 * degraded to 13s -> 59s per request with most callers timing out
 * entirely - the uploads, not the AI pipeline, were the bottleneck at
 * the very first step. The row is now inserted immediately (status
 * QUEUED, URLs still empty) so the caller gets a real jobId in ~0.3s and
 * the dashboard can navigate to it right away; this function then fills
 * in the URLs and starts the pipeline once the bytes are actually up.
 *
 * Never awaited by the route - failures are handled here (they can't
 * propagate to an already-sent response), which is why every path below
 * ends in either a real dispatch or an explicit NEEDS_ATTENTION.
 */
export async function finalizeJobCreation(jobId: string, uploads: PendingJobUploads): Promise<void> {
  try {
    // uploadToCloudinary already retries transient failures internally
    // (3 attempts, exponential backoff + jitter) - only a genuinely
    // persistent failure reaches the catch below. The whole 3-upload
    // group takes one semaphore slot (not three) so a slot maps to "one
    // job's uploads", which is the unit that actually has to finish for
    // the job to start moving.
    const [ref1Upload, ref2Upload, logoUpload] = await uploadSemaphore.run(() =>
      Promise.all([
        uploadToCloudinary(uploads.reference1, { folder: 'references' }),
        uploadToCloudinary(uploads.reference2, { folder: 'references' }),
        // No logo is a supported campaign shape, not a missing input.
        uploads.logo ? uploadToCloudinary(uploads.logo, { folder: 'logos' }) : Promise.resolve(null),
      ])
    );

    const job = await db.job.update({
      where: { id: jobId },
      data: {
        reference1Url: ref1Upload.secureUrl,
        reference2Url: ref2Upload.secureUrl,
        logoUrl: logoUpload?.secureUrl ?? '',
        status: 'BASE_LAYER_CLASSIFYING',
      },
    });

    emitStatusChanged(jobId, 'BASE_LAYER_CLASSIFYING');

    // base_layer_classification runs first - base_asset's buildPrompt
    // depends on job.baseLayerSpecJson, which only exists once this
    // stage passes. Dispatched here rather than in the route because it
    // reads job.reference2Url, which only became real a few lines above.
    const classificationStage = getStageDefinition('base_layer_classification');
    await dispatchStageJob({
      jobId,
      stage: 'base_layer_classification',
      attemptNumber: 1,
      prompt: classificationStage.buildPrompt(job),
      inputAssetUrl: classificationStage.getInputAssetUrl(job),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, job_id: jobId }, 'job_creation_upload_failed');

    // The response is long gone, so the only way the user finds out is
    // the job's own state - same NEEDS_ATTENTION treatment any other
    // exhausted-retries technical failure gets (see
    // handle-stage-result.ts's escalateTechnicalFailure), so it surfaces
    // in the dashboard's Attention tab rather than sitting silently in
    // QUEUED forever.
    await db.job
      .update({ where: { id: jobId }, data: { status: 'NEEDS_ATTENTION' } })
      .catch((updateErr) => logger.error({ err: updateErr, job_id: jobId }, 'job_creation_failure_status_write_failed'));

    emitStatusChanged(jobId, 'NEEDS_ATTENTION');
    emitNeedsAttention(jobId, 'job_creation', `Reference image upload failed after retries: ${message}`);
  }
}
