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

      // A job with no logo has no lockup to preserve, so every logo
      // clause below has to disappear - the fidelity rubric otherwise
      // HARD-FAILS ("automatic fail, score 3 or lower") on the absence
      // of something that was never placed.
      const hasLogo = !!job.logoUrl;

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
          { url: inputAssetUrl, role: `The approved poster - recompose its exact photo, ${hasLogo ? 'logo, ' : ''}and text into the new aspect ratio, do not redesign it.` },
        ],
        cloudinaryFolder: `jobs/${job.id}/dimension-${dimension}`,
        // No distinct per-dimension "SCORING" JobStatus exists in the
        // state machine (dimension progress is tracked on DimensionJob
        // rows, not the parent Job.status) - DIMENSION_EXPANDING already
        // covers this window at the parent level.
        scoringStatus: 'DIMENSION_EXPANDING',
        resizeToExact: target,
        // Real defect found live (job eeb3f754, the 4x5): this stage was
        // the one remaining generateAndScore() caller that never passed
        // qaReferenceImages, so the QA judge scored the recomposition
        // completely BLIND - it never saw the poster it was supposed to
        // be a recomposition OF. Gemini returned a total redesign (a
        // different runner, a flat vector Charminar instead of the
        // photographic one, a different logo lockup, and the subtext
        // rendered twice) and it scored 10/10 - the highest of the three
        // dimensions - because the old rubric below only ever asked
        // about seams and stretching, both of which a clean redesign
        // passes perfectly. Its own reasoning even described the vector
        // monument approvingly. Exactly the same blind-judge bug already
        // fixed twice in this pipeline (base_asset's rubric, and
        // poster's "photo/logo unaltered" check, which likewise declared
        // a visibly different photo unaltered until the real before-image
        // was attached).
        qaReferenceImages: [
          {
            url: inputAssetUrl,
            label:
              `The approved 1:1 poster this image is supposed to be a RECOMPOSITION of. Compare the submitted image against this one directly - same photo, same person, ${hasLogo ? 'same logo, ' : ''}same text, same visual style, only the canvas shape should differ.`,
          },
        ],
        rubricPrompt: `Score this aspect-ratio recomposition out of 10. The second attached image is the approved source poster; the first is the recomposed version being judged. This was supposed to reshape that exact poster into a ${dimension} canvas - NOT redesign it, NOT regenerate it, NOT reinterpret it.

FIDELITY TO THE SOURCE - check each against the source poster, any single mismatch here is an automatic fail (score 3 or lower, and say exactly which one):
- The photographed subject must be the SAME person: same face, same build, same clothing, same pose. A different-looking runner is a hard fail, however good the new one looks.
- Any photographic background element (a monument, skyline, street) must stay PHOTOGRAPHIC and be the same one. Replacing a real photographed monument with a flat illustrated/vector/silhouette version of it is a hard fail.
${hasLogo ? '- The logo must be the identical lockup - same wording, same colors, same treatment. A re-drawn or re-colored logo is a hard fail.\n' : ''}- Colors, typography and overall design language must match the source (e.g. a gradient headline must stay a gradient, not become flat).

TEXT - compare word for word against the source poster:
- Every text element in the source must appear in the recomposition EXACTLY ONCE. Any line rendered twice, any line missing, any invented text, or any altered spelling/casing is an automatic fail: score 3 or lower and quote the offending text.

RECOMPOSITION QUALITY - only if everything above matches:
- No visible seam, and background extended naturally into the new space.
- The subject must never appear stretched, squashed or warped; proportions must match the source.
- The layout should read as a deliberate, balanced composition for this canvas shape, not as the source with one large empty gap.`,
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
