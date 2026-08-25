import { getSocketServer, GLOBAL_ROOM } from './socket-server';
import type { JobStatus } from '@pipeline/shared-types';

export function emitStatusChanged(jobId: string, status: JobStatus): void {
  getSocketServer().to(`job:${jobId}`).emit('job:status_changed', {
    jobId,
    status,
    timestamp: new Date().toISOString(),
  });
}

export function emitApprovalRequested(jobId: string, posterUrl: string): void {
  getSocketServer().to(`job:${jobId}`).emit('job:approval_requested', { jobId, posterUrl });
}

export function emitNeedsAttention(jobId: string, stage: string, qaReasoning: string): void {
  // Per LLD §6.1: this event DOES reach the global room, since it changes
  // what the Needs Attention queue looks like.
  getSocketServer().to([`job:${jobId}`, GLOBAL_ROOM]).emit('job:needs_attention', { jobId, stage, qaReasoning });
}

export function emitJobCompleted(jobId: string, dimensions: Array<{ dimension: string; assetUrl: string }>): void {
  getSocketServer().to([`job:${jobId}`, GLOBAL_ROOM]).emit('job:completed', { jobId, dimensions });
}

export function emitJobCreated(jobId: string, createdAt: string): void {
  getSocketServer().to(GLOBAL_ROOM).emit('feed:job_created', { jobId, createdAt });
}

export function emitJobDeleted(jobId: string): void {
  // Reaches the job's own room too, not just the global feed - a second
  // tab/client with that job open needs to know it's gone, the same way
  // it already gets told about status changes.
  getSocketServer().to([`job:${jobId}`, GLOBAL_ROOM]).emit('feed:job_deleted', { jobId });
}
