import type { JobStatus } from '@prisma/client';
import { db } from '../lib/db';
import { getStageDefinition } from './stage-registry';
import { dispatchStageJob } from '../queues/dispatch';
import type { StageResult } from './types';
import { emitStatusChanged, emitApprovalRequested, emitNeedsAttention } from '../realtime/emitters';
import { logger } from '../lib/logger';

// Loosened pipeline-wide (was 8 / 3) - fewer, cheaper attempts before a
// job is either accepted or handed to a human, applied uniformly to
// every stage rather than per-stage overrides.
export const QA_PASS_THRESHOLD = 7;
export const MAX_CONTENT_RETRIES = 2; // exported so logo_composite's and poster's own retry loops (run-deterministic-stage.ts) stay in sync with this value instead of duplicating the magic number
const RECORD_NOT_FOUND = 'P2025'; // Prisma's error code for "no row matched the update"

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
type JobRow = Awaited<ReturnType<typeof db.job.findUniqueOrThrow>>;
/** A side effect deferred until after the transaction commits - see the
 *  note on PostCommitAction below for why this exists. */
type PostCommitAction = (() => Promise<void>) | undefined;

/**
 * The Orchestrator's core decision routine - LLD §5, hardened per
 * LLD §4.3 (transaction-scoped) and §4.4 (stalled jobs handled
 * upstream by BullMQ, not here). Called once per worker result,
 * regardless of which stage produced it.
 *
 * Contains no stage-specific logic: what "next stage" means, what
 * prompt to use on retry, and what queue to dispatch to all come from
 * the stage registry (5.1/5.2). This function only implements the
 * pass/retry/escalate decision itself.
 *
 * Real bug found running an actual job end to end (not caught by any
 * unit test, since those all use instant fake execute() results):
 * the deterministic-stage branch used to call runDeterministicStage()
 * - network fetches, sharp compositing, a Cloudinary upload, and a
 * *nested* handleStageResult() call - synchronously from inside this
 * function's transaction. That routinely took 7-11+ seconds, blowing
 * past Prisma's default 5000ms interactive-transaction timeout, which
 * silently rolled back the current stage's own StageAttempt update
 * even on an otherwise-successful run. The transaction below now only
 * ever does DB writes; every side effect (dispatching the next stage,
 * running a deterministic stage, emitting socket events) is returned
 * as a thunk and executed only after the transaction has committed.
 */
export async function handleStageResult(
  jobId: string,
  stage: string,
  attemptNumber: number,
  result: StageResult
): Promise<void> {
  let postCommit: PostCommitAction;

  // LLD §4.3: the read-decide-write cycle is transaction-scoped to this
  // job's row, so two concurrent events for the same job can never race
  // each other into a lost update. Kept deliberately fast (DB writes
  // only) - see the note above on why nothing slow runs in here.
  await db.$transaction(async (tx) => {
    const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });

    await tx.stageAttempt.update({
      where: { jobId_stage_attemptNumber: { jobId, stage, attemptNumber } },
      data: {
        modelUsed: result.modelUsed,
        latencyMs: result.latencyMs,
        costInr: result.costInr,
        qaScore: result.qaScore,
        qaReasoning: result.qaReasoning,
        // Every attempt's generated image, pass or fail - previously
        // only survived if it happened to be the one written onto the
        // parent Job (base_asset/logo_composite/poster). See the schema
        // comment: this is what makes retained-but-not-linked Cloudinary
        // uploads actually retrievable per PRD §7.
        assetUrl: result.assetUrl,
        // Phase 1 addition: persist the logo-detection stage's bounding
        // box so run-deterministic-stage.ts can read the real
        // AI-detected placement instead of falling through to a
        // hardcoded default.
        boundingBoxJson: result.boundingBox ?? undefined,
        // Only poster populates this (its extracted style + generated
        // copy for this specific attempt) - see StageResult.layerBreakdown's
        // own doc comment for why this exists.
        layerBreakdownJson: (result.layerBreakdown as object | undefined) ?? undefined,
        completedAt: new Date(),
        result: result.qaScore >= QA_PASS_THRESHOLD ? 'PASS' : attemptNumber < MAX_CONTENT_RETRIES ? 'RETRY' : 'ESCALATED',
      },
    });

    logger.info({
      job_id: jobId,
      stage,
      attempt_number: attemptNumber,
      qa_score: result.qaScore,
      model_used: result.modelUsed,
      latency_ms: result.latencyMs,
      cost_inr: result.costInr,
      result: result.qaScore >= QA_PASS_THRESHOLD ? 'pass' : attemptNumber < MAX_CONTENT_RETRIES ? 'retry' : 'escalated',
    }, 'stage_attempt_completed');

    if (result.qaScore >= QA_PASS_THRESHOLD) {
      postCommit = await advanceToNextStage(tx, job, stage, result);
      return;
    }

    if (attemptNumber < MAX_CONTENT_RETRIES) {
      postCommit = await retryWithFeedback(job, stage, attemptNumber, result.qaReasoning);
      return;
    }

    postCommit = await escalateToNeedsAttention(tx, job, stage, result.qaReasoning);
  });

  if (postCommit) await postCommit();
}

async function advanceToNextStage(
  tx: Tx,
  job: JobRow,
  currentStage: string,
  result: StageResult
): Promise<PostCommitAction> {
  const currentDef = getStageDefinition(currentStage);
  const updateData: Record<string, unknown> = {};

  // Real bug found while actually inspecting a completed job's output:
  // logo_composite passing was never wired to update baseAssetUrl, so
  // every downstream stage (poster, dimensions) kept reading
  // job.baseAssetUrl via getInputAssetUrl() and got back the PRE-logo
  // image - the logo never actually made it past the compositing step
  // into anything a human or the poster stage ever saw. base_asset and
  // logo_composite both write to the same field on purpose: it's the
  // one "current best base image" downstream stages read from,
  // whichever stage most recently produced it.
  if (currentStage === 'base_asset' || currentStage === 'logo_composite') {
    updateData.baseAssetUrl = result.assetUrl;
  }
  if (currentStage === 'poster') updateData.posterUrl = result.assetUrl;
  // Same "write once on pass, cache on the Job row" discipline as
  // poster's styleSpecJson: base_asset's buildPrompt reads this back
  // synchronously off `updatedJob` below (no extra DB round-trip needed
  // to dispatch the very next stage), and it's already persisted to the
  // real DB row by the time any later base_asset content-quality retry
  // re-reads the job fresh at the top of this function.
  if (currentStage === 'base_layer_classification') updateData.baseLayerSpecJson = result.baseLayerSpec;

  if (currentDef.nextStageOnPass === 'AWAITING_APPROVAL') {
    await tx.job.update({ where: { id: job.id }, data: { ...updateData, status: 'AWAITING_APPROVAL' } });
    return async () => {
      emitStatusChanged(job.id, 'AWAITING_APPROVAL');
      emitApprovalRequested(job.id, result.assetUrl ?? job.posterUrl ?? '');
    };
  }

  // Dimension stages register with nextStageOnPass: undefined (terminal
  // per dimension - Phase 6.5), so this MUST be checked before the
  // `!currentDef.nextStageOnPass` early-return below. The readme's own
  // Phase 9.1 patch note said to insert this "after" that block, which
  // would make it unreachable dead code for every dimension stage -
  // caught while writing this fresh instead of patching it in later.
  if (currentStage.startsWith('dimension_')) {
    const dimensionName = currentStage.replace('dimension_', '');
    await tx.dimensionJob.updateMany({
      where: { jobId: job.id, dimension: dimensionName },
      data: { status: 'DELIVERED', assetUrl: result.assetUrl },
    });
    return async () => {
      const { checkForCompletion } = await import('./dimension-orchestrator');
      await checkForCompletion(job.id);
    };
  }

  if (!currentDef.nextStageOnPass) {
    // Terminal stage with no further pipeline step defined here.
    return undefined;
  }

  const nextDef = getStageDefinition(currentDef.nextStageOnPass);
  await tx.job.update({ where: { id: job.id }, data: { ...updateData, status: statusForStage(nextDef.name) } });

  const updatedJob = { ...job, ...updateData } as JobRow;

  return async () => {
    emitStatusChanged(job.id, statusForStage(nextDef.name));

    if (nextDef.isDeterministic) {
      // Deterministic stages (logo_composite, poster) run inline, not
      // via the queue - LLD §4. Deferred to here (post-commit)
      // specifically because this does real, slow work - see the
      // function-level note.
      const { runDeterministicStage } = await import('./run-deterministic-stage');
      await runDeterministicStage(nextDef, updatedJob);
      return;
    }

    await dispatchStageJob({
      jobId: job.id,
      stage: nextDef.name,
      attemptNumber: 1,
      prompt: nextDef.buildPrompt(updatedJob),
      inputAssetUrl: nextDef.getInputAssetUrl(updatedJob),
    });
  };
}

async function retryWithFeedback(
  job: JobRow,
  stage: string,
  attemptNumber: number,
  qaReasoning: string
): Promise<PostCommitAction> {
  const stageDef = getStageDefinition(stage);

  if (stageDef.isDeterministic) {
    // poster's QA gate (render-poster.ts) can fail even though nothing
    // calls a generation model for pixels - the style extraction/copy
    // generation calls are still live AI, and a fresh call on retry can
    // avoid whatever the previous attempt got wrong. Re-runs inline the
    // same way the first dispatch does, not through the queue (there's
    // no execute() for a deterministic stage's worker path to call).
    return async () => {
      const { runDeterministicStage } = await import('./run-deterministic-stage');
      await runDeterministicStage(stageDef, job, attemptNumber + 1);
    };
  }

  const feedbackPrompt = stageDef.buildPrompt(job, qaReasoning);

  return async () => {
    await dispatchStageJob({
      jobId: job.id,
      stage,
      attemptNumber: attemptNumber + 1,
      prompt: feedbackPrompt,
      inputAssetUrl: stageDef.getInputAssetUrl(job),
    });
  };
}

async function escalateToNeedsAttention(
  tx: Tx,
  job: JobRow,
  stage: string,
  qaReasoning: string
): Promise<PostCommitAction> {
  // Dimension stages: a failing dimension moves only itself to
  // NEEDS_ATTENTION and never blocks its siblings - LLD §2.2.
  if (stage.startsWith('dimension_')) {
    const dimensionName = stage.replace('dimension_', '');
    await tx.dimensionJob.updateMany({
      where: { jobId: job.id, dimension: dimensionName },
      data: { status: 'NEEDS_ATTENTION' },
    });
    return async () => {
      const { checkForCompletion } = await import('./dimension-orchestrator');
      await checkForCompletion(job.id);
    };
  }

  await tx.job.update({ where: { id: job.id }, data: { status: 'NEEDS_ATTENTION' } });
  return async () => {
    // Found by actually watching a job escalate in a real browser: this
    // used to only emit job:needs_attention (global + per-job room),
    // never job:status_changed - so the Needs Attention queue correctly
    // showed the job, but anyone on that job's own detail view (which
    // only listens for status_changed) never saw its badge move past
    // whatever stage it was on when it got stuck.
    emitStatusChanged(job.id, 'NEEDS_ATTENTION');
    emitNeedsAttention(job.id, stage, qaReasoning);
  };
}

/**
 * Handles the case handleStageResult() never sees: execute() itself
 * throwing (network error, provider 401/5xx, etc.) rather than
 * returning a StageResult. BullMQ retries these on its own (LLD §4.2,
 * dispatch.ts's `attempts: 3` config) - this only runs once those
 * technical retries are exhausted. Without it, a stage whose provider
 * call is broken (e.g. an invalid API key) fails 3x inside BullMQ,
 * which then silently drops the job with no error the DB or dashboard
 * ever sees - the StageAttempt placeholder row stays `completedAt:
 * null` forever and Job.status never leaves its "generating" state,
 * indistinguishable from a job that's still legitimately in flight.
 */
export async function escalateTechnicalFailure(
  jobId: string,
  stage: string,
  attemptNumber: number,
  errorMessage: string,
  assetUrl?: string
): Promise<void> {
  const reasoning = assetUrl
    ? `Technical failure after retries exhausted: ${errorMessage} (the image itself generated successfully - only QA scoring failed)`
    : `Technical failure after retries exhausted: ${errorMessage}`;

  try {
    await db.stageAttempt.update({
      where: { jobId_stage_attemptNumber: { jobId, stage, attemptNumber } },
      data: { completedAt: new Date(), result: 'ESCALATED', qaReasoning: reasoning, assetUrl: assetUrl ?? undefined },
    });
  } catch (err: any) {
    if (err?.code === RECORD_NOT_FOUND) {
      // This fires asynchronously, after BullMQ's own backoff (up to
      // several seconds across 3 attempts) - by the time it runs, the
      // stage's attempt rows can legitimately be gone already (a manual
      // retry via retryStuckJob() deletes and redispatches this exact
      // stage before an old in-flight attempt has finished failing).
      // Racing a dead attempt is not a bug to surface; updating it would
      // just resurrect a row a newer dispatch already superseded.
      logger.warn({ job_id: jobId, stage, attempt_number: attemptNumber }, 'escalate_technical_failure_stale_attempt');
      return;
    }
    throw err;
  }

  if (stage.startsWith('dimension_')) {
    const dimensionName = stage.replace('dimension_', '');
    await db.dimensionJob.updateMany({
      where: { jobId, dimension: dimensionName },
      data: { status: 'NEEDS_ATTENTION' },
    });
    const { checkForCompletion } = await import('./dimension-orchestrator');
    await checkForCompletion(jobId);
    return;
  }

  await db.job.update({ where: { id: jobId }, data: { status: 'NEEDS_ATTENTION' } });
  emitStatusChanged(jobId, 'NEEDS_ATTENTION');
  emitNeedsAttention(jobId, stage, reasoning);
}

/** Maps a stage name to the JobStatus enum value it represents while
 *  active - the one place this mapping lives, so it is never
 *  duplicated across stage files. Typed as the real Prisma JobStatus
 *  enum, not a bare string - strict mode caught the readme's original
 *  `string` return type as a genuine type error at every call site. */
function statusForStage(stageName: string): JobStatus {
  const map: Record<string, JobStatus> = {
    base_layer_classification: 'BASE_LAYER_CLASSIFYING',
    base_asset: 'BASE_ASSET_GENERATING',
    // Position-decision + placement are one folded stage now (see
    // run-deterministic-stage.ts) - LOGO_PLACEMENT_DETECTING is emitted
    // manually mid-execution by that stage, not derived from a separate
    // registered stage name here.
    logo_composite: 'LOGO_COMPOSITING',
    poster: 'POSTER_GENERATING',
  };
  return map[stageName] ?? 'QUEUED';
}
