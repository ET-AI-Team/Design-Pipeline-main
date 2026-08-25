import { describe, it, expect } from 'bun:test';
import type { Job } from '@prisma/client';
import { listRegisteredStages } from './index';
import { getStageDefinition } from '../orchestrator/stage-registry';
import type { BaseLayerSpec } from '../providers/openai.client';

const MOCK_BASE_LAYER_SPEC: BaseLayerSpec = {
  compositionGuide: 'mock composition guide',
  backgroundTreatment: '',
  photoStyle: { colorGrading: 'mock', lighting: 'mock', setting: 'mock', framing: 'mock' },
  notes: 'mock',
};

describe('stage registration', () => {
  it('registers exactly the expected set of stages on import', () => {
    const stages = listRegisteredStages();
    expect(stages).toContain('base_layer_classification');
    expect(stages).toContain('base_asset');
    // logo position-detection and compositing are one folded stage now
    // (see run-deterministic-stage.ts's logo_composite branch) - no
    // separate logo_detection registration anymore.
    expect(stages).toContain('logo_composite');
    expect(stages).toContain('poster');
    expect(stages).toContain('dimension_9x16');
    expect(stages).toContain('dimension_4x5');
    expect(stages).toContain('dimension_1.91x1');
    expect(stages).toHaveLength(7);
  });

  it('buildPrompt returns a non-empty string for every stage except the deterministic ones', () => {
    const mockJob = {
      id: 'mock-job-id',
      reference1Url: 'https://example.com/r1.png',
      reference2Url: 'https://example.com/r2.png',
      logoUrl: 'https://example.com/logo.png',
      prompt: 'mock prompt',
      baseAssetUrl: 'https://example.com/base.png',
      posterUrl: 'https://example.com/poster.png',
      baseLayerSpecJson: MOCK_BASE_LAYER_SPEC as unknown as Job['baseLayerSpecJson'],
    } as Job;

    // logo_composite (sharp only) and poster (sharp+resvg, see
    // render-poster.ts) both moved off calling an image model - see
    // decision.md's "two stacked generative hops" finding for why
    // poster specifically was moved here.
    const deterministicStages = ['logo_composite', 'poster'];

    for (const stageName of listRegisteredStages()) {
      const def = getStageDefinition(stageName);
      const prompt = def.buildPrompt(mockJob);
      if (deterministicStages.includes(stageName)) {
        expect(prompt).toBe('');
      } else {
        expect(prompt.length).toBeGreaterThan(0);
      }
    }
  });
});
