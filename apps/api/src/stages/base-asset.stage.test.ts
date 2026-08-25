import { describe, it, expect } from 'bun:test';
import type { Job } from '@prisma/client';
import { getStageDefinition } from '../orchestrator/stage-registry';
import type { BaseLayerSpec } from '../providers/openai.client';
import { buildBaseAssetRubric } from './base-asset.stage';
import './index'; // side-effect import - registers every stage, including base_asset

function mockJob(baseLayerSpecJson: BaseLayerSpec | null): Job {
  return {
    id: 'mock-job-id',
    name: null,
    status: 'BASE_ASSET_GENERATING',
    reference1Url: 'https://example.com/r1.png',
    reference2Url: 'https://example.com/r2.png',
    logoUrl: 'https://example.com/logo.png',
    prompt: 'mock campaign brief, ten-plus characters',
    baseAssetUrl: null,
    posterUrl: null,
    styleSpecJson: null,
    baseLayerSpecJson: baseLayerSpecJson as unknown as Job['baseLayerSpecJson'],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  } as Job;
}

const CACHED_SPEC: BaseLayerSpec = {
  compositionGuide:
    'The subjects fill the right two-thirds of the frame, walking together along a path; the left third of the frame is a naturally clean, softly out-of-focus continuation of the same path, reserved as visual breathing room.',
  backgroundTreatment: '', // this fixture's reference has no added design treatment, just a plain photo
  photoStyle: {
    colorGrading: 'warm golden-hour tones, cream highlights',
    lighting: 'soft directional golden-hour sunlight',
    setting: 'outdoor tree-lined path',
    framing: 'medium-close group shot filling most of the frame',
  },
  notes: 'test fixture spec',
};

describe('base_asset buildPrompt - reference-driven composition', () => {
  const stage = getStageDefinition('base_asset');

  it('embeds the classified composition guide instead of a fixed assumption', () => {
    const prompt = stage.buildPrompt(mockJob(CACHED_SPEC));
    // The dynamic composition text, derived from the classification.
    expect(prompt).toContain('The subjects fill the right two-thirds of the frame');
    expect(prompt).toContain('naturally clean, softly out-of-focus continuation');
    // Never the old hardcoded assumption this replaces, and never a
    // fixed-ratio exclusion-zone claim - this pipeline no longer
    // pretends to reserve an exact percentage before the photo exists.
    expect(prompt).not.toContain('right two-thirds of frame; left third clean');
    expect(prompt).not.toContain('exclusionZone');
    // photoStyle drives the actual style instructions - never fixed
    // camera/lighting constants.
    expect(prompt).toContain('warm golden-hour tones, cream highlights');
    expect(prompt).toContain('soft directional golden-hour sunlight');
    expect(prompt).toContain('outdoor tree-lined path');
    expect(prompt).toContain('medium-close group shot filling most of the frame');
  });

  it('embeds the background treatment when the reference has one, omits the line when it does not', () => {
    const withTreatment: BaseLayerSpec = { ...CACHED_SPEC, backgroundTreatment: 'a soft cream gradient panel behind the subject' };
    const promptWith = stage.buildPrompt(mockJob(withTreatment));
    expect(promptWith).toContain('a soft cream gradient panel behind the subject');

    const promptWithout = stage.buildPrompt(mockJob(CACHED_SPEC)); // backgroundTreatment: ''
    expect(promptWithout).not.toContain('Background/design treatment:');
  });

  it('never re-derives the spec on a content-quality retry - buildPrompt is synchronous and reads only the cached job field', () => {
    const attempt1 = stage.buildPrompt(mockJob(CACHED_SPEC));
    const attempt2 = stage.buildPrompt(mockJob(CACHED_SPEC), 'previous attempt was too dark');

    expect(attempt2).toContain('Previous attempt feedback to address: previous attempt was too dark');
    // Same composition data both times - proves it came from the cached
    // field, not a fresh (and therefore potentially different)
    // classification call.
    for (const p of [attempt1, attempt2]) {
      expect(p).toContain('The subjects fill the right two-thirds of the frame');
    }
  });

  it('real bug found live: throws loudly rather than guessing at composition if baseLayerSpecJson is somehow unset', () => {
    // No hardcoded fallback exists anymore for composition/style - a
    // missing spec at this point is a real bug (base_layer_classification
    // always runs first and always passes before this stage is ever
    // dispatched), not a case to silently paper over with a generic
    // default.
    expect(() => stage.buildPrompt(mockJob(null))).toThrow(/base_layer_classification must run first/);
  });

  it('bookends the realism block and the no-text constraint (start and end of the prompt)', () => {
    const prompt = stage.buildPrompt(mockJob(CACHED_SPEC));
    const firstNoText = prompt.indexOf('no text, headline, subtext, CTA, footer, logo, watermark');
    const lastNoText = prompt.lastIndexOf('no text, headline, subtext, CTA, footer, logo, watermark');
    expect(firstNoText).toBeGreaterThanOrEqual(0);
    expect(lastNoText).toBeGreaterThan(firstNoText);
    expect(prompt.indexOf('visible skin texture and pores')).toBeGreaterThanOrEqual(0);
    expect(prompt).toContain('REMINDER:');
  });

  it('real bug found live: forbids leaving a blank placeholder object where text would normally appear', () => {
    // Real failure: told only "no text," the model kept literal
    // blank/textless bib cards on every subject in a group photo -
    // unnaturally flat, sharp-edged rectangles exactly where the bib's
    // number would have been, instead of omitting the bib entirely.
    const prompt = stage.buildPrompt(mockJob(CACHED_SPEC));
    expect(prompt).toContain('race bib, name tag, ID badge, sign, placard');
    expect(prompt).toContain('omit that object completely rather than rendering it blank');
  });
});

describe('buildBaseAssetRubric - situational QA, not a fixed blanket rule', () => {
  it('embeds the same style/composition context the generation prompt used, not a blank slate', () => {
    const rubric = buildBaseAssetRubric(CACHED_SPEC);
    expect(rubric).toContain('The subjects fill the right two-thirds of the frame');
    expect(rubric).toContain('warm golden-hour tones, cream highlights');
    expect(rubric).toContain('soft directional golden-hour sunlight');
  });

  it('real bug found live: still hard-fails fabricated ad-copy-style text', () => {
    const rubric = buildBaseAssetRubric(CACHED_SPEC);
    expect(rubric).toContain('automatic fail');
    expect(rubric).toMatch(/headline-style phrase.*call-to-action.*promotional line/);
  });

  it('real bug found live: no longer penalizes authentic incidental environmental text (e.g. a real monument\'s own carved inscriptions)', () => {
    const rubric = buildBaseAssetRubric(CACHED_SPEC);
    expect(rubric).toContain('authentic incidental environmental text');
    expect(rubric).toContain('carved inscriptions on a real monument or building');
    expect(rubric).toContain('is NOT a failure');
  });

  it('real bug found live: judges realism against the reference\'s own actual treatment, not a generic photorealism bar', () => {
    const rubric = buildBaseAssetRubric(CACHED_SPEC);
    expect(rubric).toContain('judge this image against what THOSE references actually look like');
    expect(rubric).toContain('not against "does it look like an unedited photograph."');
  });

  it('embeds the background treatment when present, omits the line when absent - same as the generation prompt', () => {
    const withTreatment: BaseLayerSpec = { ...CACHED_SPEC, backgroundTreatment: 'a soft cream gradient panel behind the subject' };
    expect(buildBaseAssetRubric(withTreatment)).toContain('a soft cream gradient panel behind the subject');
    expect(buildBaseAssetRubric(CACHED_SPEC)).not.toContain('Background/design treatment:');
  });
});
