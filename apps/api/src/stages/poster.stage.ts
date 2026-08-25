import type { Job } from '@prisma/client';
import { registerStage } from '../orchestrator/stage-registry';

// Was a queued Gemini Pro generation stage - moved to deterministic
// (see render-poster.ts and decision.md's "two stacked generative hops"
// finding). Same reasoning as logo_composite: a second full image
// regeneration doesn't reproduce the base photo, it reinterprets it, so
// this is now sharp+resvg compositing on the exact base_asset/
// logo_composite pixels instead, with AI only deciding the ad copy text
// (a cheap text-only call inside render-poster.ts, not an image call).
registerStage({
  name: 'poster',
  queue: 'image-generation', // unused for a deterministic stage, kept for type completeness
  nextStageOnPass: 'AWAITING_APPROVAL',
  isDeterministic: true,
  buildPrompt: () => '', // no prompt - this stage never calls an image model
  getInputAssetUrl: (job: Job) => job.baseAssetUrl ?? undefined,
});
