import type { Job } from '@prisma/client';
import { DIMENSION_NAMES } from '@pipeline/shared-types';
import { db } from '../lib/db';
import { dispatchStageJob } from '../queues/dispatch';
import { getStageDefinition } from './stage-registry';
import { emitJobCompleted } from '../realtime/emitters';

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
