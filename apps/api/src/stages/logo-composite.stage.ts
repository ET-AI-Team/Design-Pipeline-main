import type { Job } from '@prisma/client';
import { registerStage } from '../orchestrator/stage-registry';

registerStage({
  name: 'logo_composite',
  queue: 'image-generation', // unused for a deterministic stage, kept for type completeness
  nextStageOnPass: 'poster',
  isDeterministic: true,
  buildPrompt: () => '', // no prompt - this stage never calls a model
  getInputAssetUrl: (job: Job) => job.baseAssetUrl ?? undefined,
});
