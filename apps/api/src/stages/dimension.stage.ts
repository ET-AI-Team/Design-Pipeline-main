import type { Job } from '@prisma/client';
import { DIMENSION_NAMES, type DimensionName } from '@pipeline/shared-types';
import { registerStage } from '../orchestrator/stage-registry';
import { generateAndScore } from './generate-and-score';
import { planDimensionRecomposition } from '../providers/openai.client';
import { requireEnv } from '../lib/env';

/** Real ad-platform sizes per ratio, not an arbitrary scale of whatever
 *  the 1:1 poster happens to be - 9x16 is the standard Stories/Reels
 *  canvas, 4x5 the standard feed-portrait canvas, 1.91x1 the standard
 *  Meta/LinkedIn link-ad canvas. Also what makes the safe-margin pixel
 *  math in buildDimensionRecompositionPrompt concrete instead of vague -
 *  and what resizeToExact below defensively enforces, since Gemini has
 *  been directly observed NOT hitting a requested pixel size reliably. */
const DIMENSION_TARGET_SIZE: Record<DimensionName, { width: number; height: number }> = {
  '9x16': { width: 1080, height: 1920 },
  '4x5': { width: 1080, height: 1350 },
  '1.91x1': { width: 1200, height: 630 },
};

for (const dimension of DIMENSION_NAMES) {
  const target = DIMENSION_TARGET_SIZE[dimension];

  registerStage({
    name: `dimension_${dimension}`,
    queue: 'image-generation',
    nextStageOnPass: undefined, // terminal per dimension; completion is checked by dimension-orchestrator.ts
    // Deliberately NOT the final Gemini-facing prompt anymore - see
    // execute() below, which plans the real prompt fresh from the
    // actual poster pixels. This is now just a short boilerplate seed
    // (kept non-empty per the stage-registration invariant every non-
    // deterministic stage's buildPrompt must satisfy) that also carries
    // the previous attempt's QA feedback through the dispatch/retry
    // plumbing when present - execute() forwards it as extra context.
    buildPrompt: (_job: Job, previousFeedback?: string) => {
      const base = `Recompose the approved poster into ${dimension} aspect ratio - extend the background naturally, never stretch the subject, no visible seam.`;
      return previousFeedback ? `${base}\n\nPrevious attempt feedback to address: ${previousFeedback}` : base;
    },
    getInputAssetUrl: (job: Job) => job.posterUrl ?? undefined,
    execute: async (job, prompt, inputAssetUrl) => {
      if (!inputAssetUrl) {
        throw new Error(`dimension_${dimension}: job ${job.id} has no posterUrl to recompose from`);
      }

      // Real defect this replaces: the old prompt was one hardcoded
      // line, blind to what the actual poster contains - confirmed live
      // to produce a duplicated/garbled headline and a stretched subject
      // on a real recomposition. GPT-4.1 vision (a different model from
      // the gemini-3-pro-image call below - never self-planned, same as
      // every other stage in this pipeline) looks at the real, current
      // posterUrl and transcribes it; the actual instruction sent to
      // Gemini is then assembled deterministically from that
      // transcription, never trusted as the vision model's own prose.
      const planned = await planDimensionRecomposition({
        posterUrl: inputAssetUrl,
        dimensionLabel: dimension,
        targetWidth: target.width,
        targetHeight: target.height,
        // Only 9x16 is a full-bleed vertical Stories/Reels placement
        // with real platform UI chrome to keep clear of - 4x5 and
        // 1.91x1 are feed/link-ad shapes with no equivalent safe zone.
        includeSafeMargins: dimension === '9x16',
        pipelineContext: prompt || undefined,
      });

      const result = await generateAndScore({
        jobId: job.id,
        prompt: planned.prompt,
        // NFR §4 Scenario B (Flash for dimensions) is the cost target but
        // remains PENDING the Phase 12 A/B test as of this build - using
        // the confirmed Scenario A fallback (Pro throughout) until that
        // test actually validates Flash meets the same seam/blend rubric.
        // Switching later is a one-line change here, not a redesign.
        model: requireEnv('GEMINI_PRO_MODEL'),
        referenceImages: [
          { url: inputAssetUrl, role: 'The approved poster - recompose its exact photo, logo, and text into the new aspect ratio, do not redesign it.' },
        ],
        cloudinaryFolder: `jobs/${job.id}/dimension-${dimension}`,
        // No distinct per-dimension "SCORING" JobStatus exists in the
        // state machine (dimension progress is tracked on DimensionJob
        // rows, not the parent Job.status) - DIMENSION_EXPANDING already
        // covers this window at the parent level.
        scoringStatus: 'DIMENSION_EXPANDING',
        resizeToExact: target,
        // Unchanged - QA/scoring is not part of this change.
        rubricPrompt:
          'Score this aspect-ratio recomposition out of 10 for seam visibility and natural background extension. The subject must never appear stretched, and the image must read as one continuous photograph with no visible seam.',
      });

      // The vision-planning call above is a real, separately-billed GPT-
      // 4.1 call that generateAndScore()'s own cost/latency accounting
      // has no visibility into - folded in here so StageAttempt.costInr
      // reflects the attempt's true total spend, not just Gemini's half
      // of it.
      return {
        ...result,
        costInr: result.costInr + planned.costInr,
        latencyMs: result.latencyMs + planned.latencyMs,
      };
    },
  });
}
