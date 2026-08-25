import type { Job } from '@prisma/client';
import { DIMENSION_NAMES } from '@pipeline/shared-types';
import { registerStage } from '../orchestrator/stage-registry';
import { generateAndScore } from './generate-and-score';
import { requireEnv } from '../lib/env';

for (const dimension of DIMENSION_NAMES) {
  registerStage({
    name: `dimension_${dimension}`,
    queue: 'image-generation',
    nextStageOnPass: undefined, // terminal per dimension; completion is checked by dimension-orchestrator.ts
    buildPrompt: (job: Job, previousFeedback?: string) => {
      const base = `Recompose this approved poster into ${dimension} aspect ratio. Extend the photo's background naturally - never stretch the subject. The image must read as one continuous photograph, no visible seam behind the text.`;
      return previousFeedback ? `${base}\n\nPrevious attempt feedback to address: ${previousFeedback}` : base;
    },
    getInputAssetUrl: (job: Job) => job.posterUrl ?? undefined,
    execute: async (job, prompt, inputAssetUrl) => {
      return generateAndScore({
        jobId: job.id,
        prompt,
        // NFR §4 Scenario B (Flash for dimensions) is the cost target but
        // remains PENDING the Phase 12 A/B test as of this build - using
        // the confirmed Scenario A fallback (Pro throughout) until that
        // test actually validates Flash meets the same seam/blend rubric.
        // Switching later is a one-line change here, not a redesign.
        model: requireEnv('GEMINI_PRO_MODEL'),
        referenceImages: inputAssetUrl
          ? [{ url: inputAssetUrl, role: 'The approved poster - recompose its exact photo, logo, and text into the new aspect ratio, do not redesign it.' }]
          : undefined,
        cloudinaryFolder: `jobs/${job.id}/dimension-${dimension}`,
        // No distinct per-dimension "SCORING" JobStatus exists in the
        // state machine (dimension progress is tracked on DimensionJob
        // rows, not the parent Job.status) - DIMENSION_EXPANDING already
        // covers this window at the parent level.
        scoringStatus: 'DIMENSION_EXPANDING',
        rubricPrompt:
          'Score this aspect-ratio recomposition out of 10 for seam visibility and natural background extension. The subject must never appear stretched, and the image must read as one continuous photograph with no visible seam.',
      });
    },
  });
}
