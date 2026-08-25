import type { Job } from '@prisma/client';
import { registerStage } from '../orchestrator/stage-registry';
import { classifyBaseLayer, type BaseLayerSpec } from '../providers/openai.client';
import type { StageResult } from '../orchestrator/types';

// No fixed archetype/geometry to validate a range against anymore - the
// classifier now returns freeform description strings, never a category
// or a ratio. The only thing worth rejecting (triggering a real retry)
// is a genuinely malformed response - a missing or empty field - where a
// different call might actually produce a usable answer. There is
// nothing left to clamp: nothing here is a number that could be
// out-of-range, since geometry is no longer decided at this stage at
// all (see logo-detection.stage.ts and render-poster.ts's
// getOrExtractStyle for where real placement is now decided, by
// looking at the real generated image instead of this classification).
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidBaseLayerSpec(spec: BaseLayerSpec | null | undefined): spec is BaseLayerSpec {
  if (!spec) return false;
  const style = spec.photoStyle;
  return (
    isNonEmptyString(spec.compositionGuide) &&
    typeof spec.backgroundTreatment === 'string' && // allowed to be empty - "no treatment" is a real, valid answer
    !!style &&
    isNonEmptyString(style.colorGrading) &&
    isNonEmptyString(style.lighting) &&
    isNonEmptyString(style.setting) &&
    isNonEmptyString(style.framing)
  );
}

registerStage({
  name: 'base_layer_classification',
  queue: 'vision-scoring',
  nextStageOnPass: 'base_asset',
  // The real instruction lives inside classifyBaseLayer() (same split
  // logo_detection uses: this string is only the dispatch-payload/log
  // label, not what's actually sent to the model - execute() below reads
  // straight off the Job row instead of the prompt/inputAssetUrl params).
  buildPrompt: () => 'Study the layout reference image in depth and describe how its composition, background treatment, and photographic style actually work.',
  getInputAssetUrl: (job: Job) => job.reference2Url,
  execute: async (job): Promise<StageResult> => {
    const startedAt = Date.now();
    const classification = await classifyBaseLayer({
      layoutReferenceUrl: job.reference2Url,
      subjectReferenceUrl: job.reference1Url,
    });

    const valid = isValidBaseLayerSpec(classification.spec);

    return {
      baseLayerSpec: valid ? classification.spec : undefined,
      qaScore: valid ? 10 : 3,
      qaReasoning: valid
        ? `Composition: ${classification.spec.compositionGuide} Background treatment: ${classification.spec.backgroundTreatment || '(none)'} Style: ${JSON.stringify(classification.spec.photoStyle)}. ${classification.spec.notes}`
        : `Returned spec failed deterministic validation (missing or empty compositionGuide/photoStyle field): ${JSON.stringify(classification.spec)}.`,
      modelUsed: process.env.OPENAI_VISION_MODEL ?? 'unknown',
      latencyMs: Date.now() - startedAt,
      costInr: classification.costInr,
    };
  },
});
