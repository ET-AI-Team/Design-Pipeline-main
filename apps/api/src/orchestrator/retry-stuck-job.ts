import { db } from '../lib/db';
import { ApiError } from '../lib/api-error';
import { dispatchStageJob } from '../queues/dispatch';
import { getStageDefinition } from './stage-registry';
import { emitStatusChanged } from '../realtime/emitters';
import { logger } from '../lib/logger';

/** The last stage a job was actively working on before escalating -
 *  read from the most recent ESCALATED StageAttempt row. */
async function findStuckStage(jobId: string): Promise<string> {
  const lastEscalated = await db.stageAttempt.findFirst({
    where: { jobId, result: 'ESCALATED' },
    orderBy: { completedAt: 'desc' },
  });
  if (!lastEscalated) throw new ApiError('INVALID_STATE_TRANSITION', 409, 'No escalated stage found for this job');
  return lastEscalated.stage;
}

/** Implements LLD §7.1: resets the stuck stage's attempt count to 1
 *  and re-dispatches it through the normal flow, rather than
 *  requiring the whole job to be resubmitted. */
export async function retryStuckJob(jobId: string) {
  const job = await db.job.findFirst({ where: { id: jobId, deletedAt: null } });
  if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `No job with id ${jobId}`);

  if (job.status === 'NEEDS_ATTENTION') {
    const stuckStage = await findStuckStage(jobId);
    const stageDef = getStageDefinition(stuckStage);

    // Confirmed by actually clicking Retry in the dashboard on a real
    // escalated job: dispatching straight at attemptNumber 1 without
    // this delete is a silent no-op forever. A stage can only reach
    // ESCALATED after attempts 1-3 already exist as rows, so the
    // idempotent-dispatch guard (the unique constraint on
    // [jobId, stage, attemptNumber]) always sees attempt 1 as "already
    // dispatched" and swallows the retry - Job.status flips to QUEUED
    // and nothing ever actually runs again. Deleting this stage's prior
    // attempts is what makes "reset the attempt count to 1" (LLD §7.1)
    // true rather than aspirational.
    await db.stageAttempt.deleteMany({ where: { jobId, stage: stuckStage } });

    await db.job.update({ where: { id: jobId }, data: { status: 'QUEUED' } });
    emitStatusChanged(jobId, 'QUEUED');

    // Real bug found live: dispatchStageJob() always enqueues onto a
    // BullMQ queue, but logo_composite/poster are deterministic and
    // never go through one - pipeline-worker.ts's processStageJob()
    // unconditionally throws if it's ever handed a deterministic stage
    // ("should never be queued"). That throw gets treated as a
    // technical failure, retried 3x by BullMQ, then escalates the job
    // straight back to NEEDS_ATTENTION with a "technical failure"
    // reasoning - the stage never actually re-runs. Same inline path
    // handle-stage-result.ts's retryWithFeedback() already uses for
    // this exact reason.
    if (stageDef.isDeterministic) {
      const { runDeterministicStage } = await import('./run-deterministic-stage');
      // Not awaited on purpose - mirrors dispatchStageJob() below, which
      // only awaits the enqueue, not the worker actually processing it.
      // The HTTP caller gets an immediate response; real progress
      // arrives over the socket the same way a queued retry's does.
      // Errors are logged here since nothing else can catch them once
      // this function has already returned.
      runDeterministicStage(stageDef, job, 1).catch((err) =>
        logger.error({ err, job_id: jobId, stage: stuckStage }, 'retry_deterministic_stage_failed')
      );
    } else {
      await dispatchStageJob({
        jobId,
        stage: stuckStage,
        attemptNumber: 1,
        prompt: stageDef.buildPrompt(job),
        inputAssetUrl: stageDef.getInputAssetUrl(job),
      });
    }

    return db.job.findUniqueOrThrow({ where: { id: jobId } });
  }

  // Applies at the dimension level too, per LLD §7.1 - same fix as above.
  const stuckDimension = await db.dimensionJob.findFirst({ where: { jobId, status: 'NEEDS_ATTENTION' } });
  if (stuckDimension) {
    const stageName = `dimension_${stuckDimension.dimension}`;
    const stageDef = getStageDefinition(stageName);

    await db.stageAttempt.deleteMany({ where: { jobId, stage: stageName } });
    await db.dimensionJob.update({ where: { id: stuckDimension.id }, data: { status: 'PENDING' } });
    await dispatchStageJob({
      jobId,
      stage: stageName,
      attemptNumber: 1,
      prompt: stageDef.buildPrompt(job),
      inputAssetUrl: stageDef.getInputAssetUrl(job),
    });
    return job;
  }

  throw new ApiError('INVALID_STATE_TRANSITION', 409, 'Job is not in a retryable state', { currentStatus: job.status });
}
