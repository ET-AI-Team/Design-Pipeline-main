import { db } from '../lib/db';
import { ApiError } from '../lib/api-error';
import { emitStatusChanged } from './emitters';
import { onApproved } from '../orchestrator/dimension-orchestrator';
import { logger } from '../lib/logger';

async function assertAwaitingApproval(jobId: string) {
  const job = await db.job.findFirst({ where: { id: jobId, deletedAt: null } });
  if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `No job with id ${jobId}`);
  if (job.status !== 'AWAITING_APPROVAL') {
    throw new ApiError('INVALID_STATE_TRANSITION', 409, 'Job is not awaiting approval', { currentStatus: job.status });
  }
  return job;
}

export async function approveJob(jobId: string) {
  const job = await assertAwaitingApproval(jobId);

  await db.approvalLog.create({ data: { jobId, decision: 'approve', decidedAt: new Date() } });
  logger.info({ job_id: jobId, human_decision: 'approve' }, 'approval_recorded');

  const updated = await db.job.update({ where: { id: jobId }, data: { status: 'DIMENSION_EXPANDING' } });
  emitStatusChanged(jobId, 'DIMENSION_EXPANDING');

  await onApproved(job);
  return updated;
}

export async function rejectJob(jobId: string, comment?: string) {
  const job = await assertAwaitingApproval(jobId);

  await db.approvalLog.create({ data: { jobId, decision: 'reject', comment, decidedAt: new Date() } });
  logger.info({ job_id: jobId, human_decision: 'reject', comment }, 'approval_recorded');

  const updated = await db.job.update({ where: { id: jobId }, data: { status: 'REJECTED' } });
  emitStatusChanged(jobId, 'REJECTED');
  return updated;
}
