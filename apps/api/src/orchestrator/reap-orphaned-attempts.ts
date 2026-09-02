import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { escalateTechnicalFailure } from './handle-stage-result';

/**
 * Recovers StageAttempt rows that were abandoned in flight - claimed
 * (completedAt: null) but never resolved, because the process died or
 * restarted mid-stage.
 *
 * Real, recurring problem this fixes: three jobs were found stuck with
 * `poster` attempt 1 at completedAt: null, one each on 2026-08-31,
 * 09-01 and 09-02. Nothing could recover them - Job.status never leaves
 * its "generating" state, so the dashboard spins "in progress" forever,
 * and retryStuckJob() can't help either because it looks for an
 * ESCALATED attempt, which is exactly what never gets written when work
 * is simply abandoned rather than failed. BullMQ's own stalled-job
 * detection covers this for QUEUED stages, but logo_composite/poster run
 * inline and have no equivalent safety net.
 *
 * Escalating (rather than silently re-running) is deliberate: it writes
 * the ESCALATED row that POST /jobs/:id/retry already knows how to
 * recover from, so a stuck job becomes a one-click fix in the existing
 * Needs Attention queue instead of needing a manual DB edit.
 */

// Must comfortably exceed the slowest legitimate in-flight window.
// Measured p90s are 51-84s per stage and BullMQ's lockDuration is 300s,
// but a QUEUED attempt can also sit waiting behind a burst - a 30-job
// burst at concurrency 8 takes ~13 min to drain, and that row is
// legitimately completedAt: null the whole time. 20 minutes clears all
// of it with real margin.
const DEFAULT_REAP_AFTER_MINUTES = 20;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export async function reapOrphanedAttempts(): Promise<number> {
  const reapAfterMinutes = Number(process.env.ORPHAN_REAP_AFTER_MINUTES ?? DEFAULT_REAP_AFTER_MINUTES);
  const cutoff = new Date(Date.now() - reapAfterMinutes * 60 * 1000);

  const orphans = await db.stageAttempt.findMany({
    where: {
      completedAt: null,
      startedAt: { lt: cutoff },
      // Second, independent guard: only touch attempts whose parent job
      // is ALSO idle. Any real progress anywhere on a job (a status
      // change, a sibling stage finishing) bumps Job.updatedAt, so a job
      // that is visibly moving is never reaped no matter how long one
      // individual attempt has been open.
      job: { updatedAt: { lt: cutoff }, deletedAt: null },
    },
    select: { jobId: true, stage: true, attemptNumber: true, startedAt: true },
  });

  for (const o of orphans) {
    const ageMinutes = Math.round((Date.now() - o.startedAt.getTime()) / 60_000);
    logger.warn(
      { job_id: o.jobId, stage: o.stage, attempt_number: o.attemptNumber, age_minutes: ageMinutes },
      'reaping_orphaned_attempt'
    );
    // escalateTechnicalFailure is itself scoped to completedAt: null, so
    // an attempt that finished between the query above and this call is
    // left alone rather than clobbered.
    await escalateTechnicalFailure(
      o.jobId,
      o.stage,
      o.attemptNumber,
      `no result was ever recorded after ${ageMinutes} minutes - the stage was abandoned in flight, most likely a process restart. Retry to re-run this stage.`,
      undefined,
      'Abandoned in flight'
    );
  }

  return orphans.length;
}

/** Started once from server.ts. Single instance (ADR-007), so a plain
 *  interval is sufficient - no distributed lock needed. */
export function startOrphanReaper(): void {
  const tick = () => {
    reapOrphanedAttempts()
      .then((n) => {
        if (n > 0) logger.info({ reaped: n }, 'orphan_reaper_swept');
      })
      .catch((err) => logger.error({ err }, 'orphan_reaper_failed'));
  };

  // Run once shortly after boot as well as on the interval: a restart is
  // the single most likely cause of an orphan in the first place, so the
  // rows worth cleaning up usually already exist at startup.
  setTimeout(tick, 30_000);
  setInterval(tick, SWEEP_INTERVAL_MS);
  logger.info({ sweep_interval_ms: SWEEP_INTERVAL_MS }, 'orphan_reaper_started');
}
