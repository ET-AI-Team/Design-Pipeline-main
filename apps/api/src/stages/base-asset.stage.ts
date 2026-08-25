import type { Job } from '@prisma/client';
import { registerStage } from '../orchestrator/stage-registry';
import { generateAndScore } from './generate-and-score';
import { requireEnv } from '../lib/env';
import type { BaseLayerSpec } from '../providers/openai.client';

interface BaseAssetPrompt {
  subject: string;
  scene: string;
  mood: string;
  photoStyle: BaseLayerSpec['photoStyle'];
  realismBlock: { positive: string; negative: string };
  compositionGuide: string;
  backgroundTreatment: string;
  negativeConstraints: string[];
  quality: string;
}

/** Builds the structured prompt object from the three inputs: the
 *  user's raw brief (reframed as direction only, never verbatim copy),
 *  the cached base-layer classification, and a fixed realism block. No
 *  new AI call decomposes the brief into subject/scene/mood separately -
 *  that would be new scope beyond this task - so the full reframed brief
 *  carries the actual content under `scene`, and `subject`/`mood` are
 *  short, non-duplicative pointers back to it rather than a fabricated
 *  three-way split. No hardcoded fallback for compositionGuide/
 *  backgroundTreatment/photoStyle: base_layer_classification always runs
 *  first and this prompt is only ever built once its output is validated
 *  and persisted (see stage-registry.ts's nextStageOnPass wiring) - a
 *  missing spec at this point is a real bug, not a case to silently
 *  paper over with a generic default. */
function buildBaseAssetPrompt(job: Job, spec: BaseLayerSpec): BaseAssetPrompt {
  return {
    subject:
      'The real person/subject and scenario described in the campaign brief below - not a stock-photo or fashion-model type. Indian setting and subject by default (Indian ethnicity, clothing, home/office environment) unless the campaign brief below clearly specifies a different market.',
    mood: 'Matches the tone of the campaign brief below - natural and authentic, not artificially staged.',
    scene: job.prompt,
    photoStyle: spec.photoStyle,
    realismBlock: {
      positive:
        'visible skin texture and pores, natural under-eye detail, slight natural asymmetry in facial features, candid unposed expression, no retouching, no beauty filter',
      negative: 'no smooth/waxy/airbrushed skin, no studio-lit symmetric portrait look, no AI-rendering look, no compression artifacts',
    },
    compositionGuide: spec.compositionGuide,
    backgroundTreatment: spec.backgroundTreatment,
    negativeConstraints: [
      'no text, headline, subtext, CTA, footer, logo, watermark, or typography of any kind anywhere in the image - even if the campaign brief below describes specific copy or text content; all text is composited in a separate later step',
      // Real defect found live: told only "no text," the model kept
      // literal blank/textless versions of text-bearing objects (e.g. a
      // race bib card) instead of removing the object itself - every
      // subject in a real generated group photo had an unnaturally
      // flat, sharp-edged, blank rectangle on their chest exactly where
      // a bib's text would have been. The fix is telling it to omit the
      // whole object, not just its text.
      'if the scenario would normally include an object whose entire purpose is to display text or numbers (a race bib, name tag, ID badge, sign, placard, or similar) - omit that object completely rather than rendering it blank; the surrounding clothing/surface must look natural and continuous, as if the object was never there, not like a blank card or patch was placed over it',
    ],
    quality:
      'highest possible quality: sharp focus, high resolution, professional commercial photography, natural realistic detail in skin/fabric/materials, no compression artifacts, no AI-rendering look',
  };
}

/** Serializes the structured prompt into the actual text sent to
 *  Gemini. The realism block and the "no text" constraint are bookended
 *  - stated up front (primacy) and repeated again at the end - because a
 *  single trailing mention was confirmed live to lose out to a detailed
 *  brief that had its own explicit copy in it (Gemini rendered the
 *  poster text anyway regardless of a single negative instruction).
 *  Also embeds the structured spec as a literal JSON block, both for
 *  the model to read as an unambiguous machine-readable structure and
 *  so a human reading logs can see exactly what was asked for.
 *
 *  compositionGuide/backgroundTreatment are steering language, not a
 *  guarantee - this pipeline no longer claims to reserve an exact
 *  percentage of the frame as clean space before the photo exists.
 *  Exactly where the logo and text end up is decided AFTER this photo
 *  is real, by looking at it (logo-detection.stage.ts,
 *  render-poster.ts's getOrExtractStyle) - this prompt only steers the
 *  generation toward a composition that tends to leave room, matching
 *  the reference's own compositional feel. */
function serializeBaseAssetPrompt(p: BaseAssetPrompt): string {
  return `Generate ONLY a photorealistic base photograph for stage 1 of a multi-stage pipeline. ${p.quality}.

${p.negativeConstraints.join(' ')}

Realism (required): ${p.realismBlock.positive}.

Two reference images are attached below - match their actual photographic style as closely as possible while generating a DIFFERENT photo (different subject/scene per the brief, never a copy of the reference's specific people, text, or logo). Style to match:
- Color grading: ${p.photoStyle.colorGrading}
- Lighting: ${p.photoStyle.lighting}
- Setting: ${p.photoStyle.setting}
- Framing: ${p.photoStyle.framing}

Composition: compose this photo so it naturally reads like the reference's own composition - ${p.compositionGuide}
${p.backgroundTreatment ? `Background/design treatment: the reference also uses a design treatment that isn't part of the photo's natural content - replicate it directly in this photo: ${p.backgroundTreatment}. If any part of that description itself refers to letters, words, numbers, or a wordmark, ignore that part entirely - replicate only its color, shape, or texture, never any letterform; this image must still contain absolutely no text of any kind.` : ''}

Subject: ${p.subject}
Mood: ${p.mood}

Campaign brief (use ONLY for subject, scene, mood, and setting - ignore any text/copy/CTA/headline content it describes):
${p.scene}

Structured spec for this generation (for reference, matches the instructions above):
${JSON.stringify(p, null, 2)}

REMINDER: ${p.negativeConstraints.join(' ')} Avoid at all costs: ${p.realismBlock.negative}.`;
}

/** Real gap found live: the old rubric was one fixed string, identical
 *  on every job, that (a) auto-failed on ANY rendered text with zero
 *  ability to tell a real monument's own authentic carved inscriptions
 *  (visible in the attached reference) from hallucinated ad-copy, and
 *  (b) judged realism/composition against a generic "must look like an
 *  unedited photo" bar even when the reference's own style is
 *  deliberately stylized/graphic/duotone. Both failures trace to the
 *  same cause: the QA call never saw the reference image or the
 *  extracted style spec, only the candidate image and a fixed rubric.
 *  This version is dynamic per job (same input, same shape as
 *  buildBaseAssetPrompt above) and judges against that job's own real
 *  situational target instead of a blank-slate assumption. */
export function buildBaseAssetRubric(spec: BaseLayerSpec): string {
  return `Score this base image out of 10 for composition and realism. Two reference images are attached - judge this image against what THOSE references actually look like, not a generic assumption. If the references (and the style notes below) show a deliberately stylized, graphic, duotone, or non-strictly-photorealistic treatment, judge realism/coherence against THAT target, not against "does it look like an unedited photograph."

Style this generation was directed to match:
- Composition: ${spec.compositionGuide}
${spec.backgroundTreatment ? `- Background/design treatment: ${spec.backgroundTreatment}` : ''}
- Color grading: ${spec.photoStyle.colorGrading}
- Lighting: ${spec.photoStyle.lighting}
- Setting: ${spec.photoStyle.setting}
- Framing: ${spec.photoStyle.framing}

TEXT RULE - read carefully, this is not a blanket ban: this pipeline composites all real campaign copy (headline, CTA, trust points, prices, promo badges) onto this photo in a SEPARATE later stage, so text that reads like fabricated ad-copy - a headline-style phrase, a call-to-action, a promotional line, a price, a brand wordmark not present in the references - is still an automatic fail: score 3 or lower, and say exactly what text you found and why it reads as ad-copy.
However, authentic incidental environmental text - real signage, carved inscriptions on a real monument or building, distant or blurred lettering that is a natural part of an honest real-world scene, consistent with the attached reference images and the style notes above - is NOT a failure and must not be scored down for being present, exactly as it would appear in an actual unedited photograph of that real place or object. If you see text and are unsure which category it falls into, say so explicitly in your reasoning and judge based on whether it looks like it was composited/rendered as design copy versus whether it looks like a physically real part of the scene.`;
}

registerStage({
  name: 'base_asset',
  queue: 'image-generation',
  // logo placement (position + composite) is now one folded deterministic
  // stage, not a separate AI-decision stage feeding a separate
  // execution stage - see run-deterministic-stage.ts's logo_composite
  // branch for why.
  nextStageOnPass: 'logo_composite',
  buildPrompt: (job: Job, previousFeedback?: string) => {
    const spec = job.baseLayerSpecJson as unknown as BaseLayerSpec | null;
    if (!spec) {
      // base_layer_classification always runs first and always PASSES
      // before this stage is ever dispatched - a missing spec here means
      // that invariant broke, not a case to guess a default for. Same
      // "surface loudly rather than guess at geometry" principle the
      // poster stage already uses for its own missing-spec case.
      throw new Error(`base_asset stage: job ${job.id} has no baseLayerSpecJson - base_layer_classification must run first`);
    }
    const base = serializeBaseAssetPrompt(buildBaseAssetPrompt(job, spec));
    return previousFeedback ? `${base}\n\nPrevious attempt feedback to address: ${previousFeedback}` : base;
  },
  getInputAssetUrl: () => undefined, // no prior asset to read - base_layer_classification produces a spec, not an image
  execute: async (job, prompt) => {
    const spec = job.baseLayerSpecJson as unknown as BaseLayerSpec;
    return generateAndScore({
      jobId: job.id,
      prompt,
      // Switched from Flash to Pro: the structured, classifier-informed
      // prompt is a materially harder instruction-following task (a
      // detailed composition guide + a full realism block, not a fixed
      // template) than what Flash was validated against - Pro is used
      // everywhere else in this pipeline that needs the same fidelity
      // (poster's photo, dimension expansion).
      model: requireEnv('GEMINI_PRO_MODEL'),
      // Real defect found live: only Reference-01 was ever attached here,
      // and the prompt's style description came from fixed constants, not
      // the reference - Gemini had nothing to actually match. Both
      // references are now attached (Reference-02 is the same image
      // base_layer_classification read style/composition from), so the
      // model has the real visual target, not just a text description of
      // one, on top of the photoStyle text above.
      referenceImages: [
        { url: job.reference1Url, role: 'Reference 1 - subject/scenario direction only. Do not copy its specific people, text, logo, or watermark - generate a different subject per the brief below.' },
        { url: job.reference2Url, role: 'Reference 2 - match this image\'s actual color grading, lighting, setting, and framing as closely as possible (see the photoStyle description above). Do not copy its specific people, text, logo, or watermark.' },
      ],
      // Same URLs/roles as the Gemini generation call above, reworded for
      // the QA audience - lets the QA judge actually compare against the
      // real reference instead of a fixed, situation-blind rubric.
      qaReferenceImages: [
        { url: job.reference1Url, label: 'Reference 1 - the subject/scenario direction this generation was aiming for.' },
        { url: job.reference2Url, label: "Reference 2 - the actual photographic style (color grading, lighting, setting, framing, background/design treatment) this generation was directed to match." },
      ],
      cloudinaryFolder: `jobs/${job.id}/base-asset`,
      scoringStatus: 'BASE_ASSET_SCORING',
      // Real defect found live: Gemini generated a 1408x768 image
      // despite the prompt asking for "1:1 square" - see
      // generate-and-score.ts's enforceSquareCanvas doc comment. Every
      // box-geometry assumption downstream (the real, post-generation
      // logo/text placement decisions) depends on this canvas actually
      // being square.
      enforceSquare: true,
      rubricPrompt: buildBaseAssetRubric(spec),
    });
  },
});
