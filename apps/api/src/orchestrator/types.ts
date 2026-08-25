import type { Job } from '@prisma/client';
import type { BaseLayerSpec } from '../providers/openai.client';

export type QueueName = 'image-generation' | 'vision-scoring';

export interface StageResult {
  assetUrl?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  /** Only populated by base_layer_classification on PASS - handle-stage-
   *  result.ts persists it to Job.baseLayerSpecJson, the same "write once
   *  on pass, cached on the Job row" pattern boundingBox/logo_detection
   *  and styleSpecJson/poster already use. */
  baseLayerSpec?: BaseLayerSpec;
  /** Only populated by poster, on every attempt (pass or fail) - the
   *  extracted PosterStyleSpec + generated AdCopy for THIS attempt,
   *  written to StageAttempt.layerBreakdownJson so a real run's actual
   *  prompt inputs are retrievable after the fact instead of guessed at.
   *  Deliberately per-attempt, not cached on Job like baseLayerSpec -
   *  styleSpecJson extraction is intentionally uncached per attempt (see
   *  render-poster.ts's getOrExtractStyle), so what actually drove each
   *  attempt can genuinely differ attempt to attempt. */
  layerBreakdown?: unknown;
  qaScore: number;
  qaReasoning: string;
  modelUsed: string;
  latencyMs: number;
  costInr: number;
}

/**
 * The contract every pipeline stage registers under. The Orchestrator
 * engine (5.3) only ever calls these methods - it never contains a
 * stage name as a string literal outside of routing through this
 * interface. Adding a new stage means writing one of these, not
 * touching the engine.
 */
export interface StageDefinition {
  /** Unique stage identifier, matches StageAttempt.stage values. */
  name: string;

  /** Which provider-scoped queue this stage's work runs on. */
  queue: QueueName;

  /** Builds the prompt for this attempt, given the job and any prior
   *  QA feedback (present on content-quality retries). */
  buildPrompt(job: Job, previousFeedback?: string): string;

  /** The asset this stage should read from, if any (e.g. poster
   *  generation reads the logo-composited base asset). */
  getInputAssetUrl(job: Job): string | undefined;

  /** The stage name to advance to on a passing QA score. A special
   *  value 'AWAITING_APPROVAL' signals the human checkpoint; a stage
   *  can also return undefined if it is itself terminal (e.g. a
   *  dimension stage). */
  nextStageOnPass: string | 'AWAITING_APPROVAL' | undefined;

  /** True for stages that are deterministic code with no external
   *  provider call (e.g. logo compositing) - these never go through
   *  the queue and complete synchronously inside the engine. */
  isDeterministic?: boolean;

  /**
   * Not in the original plan: no BullMQ Worker was ever defined anywhere
   * in the readme, so nothing actually connected "job dispatched" to
   * "job produces a result." This is that connection point - the
   * generic Worker calls this for every non-deterministic stage. It
   * owns calling the right provider function(s) with the right
   * env-configured model, and per HLD's retry-loop diagram (one worker
   * call returns both an asset AND a QA score together), bundles
   * generate+score into one call rather than dispatching them as two
   * separate queue round-trips. Omitted for deterministic stages, which
   * never go through the queue at all.
   *
   * Takes `prompt`/`inputAssetUrl` directly from the StageJobPayload
   * rather than re-deriving them via buildPrompt()/getInputAssetUrl() -
   * dispatchStageJob() already computed those once (with any QA
   * feedback already folded into the prompt on a retry); recomputing
   * them here would be redundant, not just differently-shaped.
   */
  execute?(job: Job, prompt: string, inputAssetUrl?: string): Promise<StageResult>;
}
