import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { stripDashes, stripDashesFromLines, buildDimensionRecompositionPrompt, planDimensionRecomposition } from './openai.client';

describe('stripDashes', () => {
  it('replaces a mid-sentence hyphen with a comma', () => {
    expect(stripDashes('Relief - fast and easy')).toBe('Relief, fast and easy');
  });

  it('replaces a TIGHT em-dash (no surrounding whitespace) with a space, not a comma', () => {
    // Real generated output has used one this way. A comma here would
    // still read fine for this particular sentence, but see the
    // compound-word tests below for why a fixed ", " for every
    // no-whitespace dash is wrong in general - a space is the one
    // replacement that stays correct for both cases.
    expect(stripDashes('Daily stretches for lasting relief—at your desk.')).toBe('Daily stretches for lasting relief at your desk.');
  });

  it('removes a leading/trailing dash without leaving a stray comma', () => {
    expect(stripDashes('-Start Now-')).toBe('Start Now');
  });

  it('leaves text with no dash untouched', () => {
    expect(stripDashes('Ease Neck & Shoulder Pain')).toBe('Ease Neck & Shoulder Pain');
  });

  it('real bug found live: a hyphenated compound word gets a space, not a comma - a real generated headline read "mom, to, be?" instead of "mom-to-be?" because the old fixed ", " replacement doesn\'t know a tight hyphen can be structurally part of one word, not a clause separator', () => {
    expect(stripDashes('Lower back pain, mom-to-be?')).toBe('Lower back pain, mom to be?');
  });

  it('real bug found live: same defect hit a trust-list item on the same job - "Doctor-approved plans" became "Doctor, approved plans"', () => {
    expect(stripDashes('Doctor-approved plans')).toBe('Doctor approved plans');
  });

  it('still uses a comma for a genuinely spaced dash (a real two-clause separator, not a compound word)', () => {
    expect(stripDashes('Save time - feel great')).toBe('Save time, feel great');
  });
});

describe('stripDashesFromLines', () => {
  it('real bug found live: converts a dash at a line-BREAK boundary to a comma, not a deletion', () => {
    // The exact real failure: "Say Goodbye to Pain -" / "Feel Relief in
    // Minutes" rendered as "Say Goodbye to Pain Feel Relief in Minutes"
    // (missing conjunction) because the old per-line stripDashes() call
    // treated the trailing dash on line 1 as a string EDGE and deleted
    // it outright, rather than recognizing it as mid-sentence relative
    // to the whole headline.
    const result = stripDashesFromLines(['Say Goodbye to Pain -', 'Feel Relief in Minutes']);
    expect(result).toEqual(['Say Goodbye to Pain,', 'Feel Relief in Minutes']);
    expect(result.join(' ')).toBe('Say Goodbye to Pain, Feel Relief in Minutes');
  });

  it('still strips a dash at the TRUE start of the first line and TRUE end of the last line', () => {
    const result = stripDashesFromLines(['-Ease Neck & Shoulder', 'Pain in Minutes-']);
    expect(result).toEqual(['Ease Neck & Shoulder', 'Pain in Minutes']);
  });

  it('leaves lines with no dash untouched', () => {
    expect(stripDashesFromLines(['Ease Neck & Shoulder', 'Pain in Minutes'])).toEqual(['Ease Neck & Shoulder', 'Pain in Minutes']);
  });
});

describe('scoreImage', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_VISION_MODEL;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_VISION_MODEL = 'gpt-4.1';
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalKey;
    process.env.OPENAI_VISION_MODEL = originalModel;
  });

  it('throws a clear error when the API key is missing', async () => {
    process.env.OPENAI_API_KEY = '';
    const { scoreImage } = await import('./openai.client');
    await expect(
      scoreImage({ imageUrl: 'https://example.com/x.png', rubricPrompt: 'test rubric' })
    ).rejects.toThrow('OPENAI_API_KEY is not configured');
  });

  it('throws a clear error when the vision model is not configured', async () => {
    process.env.OPENAI_VISION_MODEL = '';
    const { scoreImage } = await import('./openai.client');
    await expect(
      scoreImage({ imageUrl: 'https://example.com/x.png', rubricPrompt: 'test rubric' })
    ).rejects.toThrow('OPENAI_VISION_MODEL is not configured');
  });
});

describe('verifyPoster', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_VISION_MODEL;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_VISION_MODEL = 'gpt-4.1';
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalKey;
    process.env.OPENAI_VISION_MODEL = originalModel;
  });

  it('throws a clear error when the API key is missing - same guard as scoreImage', async () => {
    process.env.OPENAI_API_KEY = '';
    const { verifyPoster } = await import('./openai.client');
    await expect(
      verifyPoster({ imageUrl: 'https://example.com/x.png', rubricPrompt: 'test rubric' })
    ).rejects.toThrow('OPENAI_API_KEY is not configured');
  });
});

describe('planDimensionRecomposition', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_VISION_MODEL;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_VISION_MODEL = 'gpt-4.1';
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalKey;
    process.env.OPENAI_VISION_MODEL = originalModel;
  });

  it('throws a clear error when the API key is missing - same guard as every other vision call', async () => {
    process.env.OPENAI_API_KEY = '';
    const { planDimensionRecomposition } = await import('./openai.client');
    await expect(
      planDimensionRecomposition({
        posterUrl: 'https://example.com/poster.png',
        dimensionLabel: '9x16',
        targetWidth: 1080,
        targetHeight: 1920,
        includeSafeMargins: true,
      })
    ).rejects.toThrow('OPENAI_API_KEY is not configured');
  });
});

describe('buildDimensionRecompositionPrompt', () => {
  const fullTranscription = {
    logoText: 'TIMES INTERNET HALF MARATHON',
    headlineLines: ['OCT 25.', "HYDERABAD'S", 'RACE DAY.'],
    subtextText: 'One start line, thousands of runners.',
    locationPillText: 'Hyderabad | Oct 25, 2026',
    ctaText: 'REGISTER NOW',
    statRowItems: ['3Km - Run For Fun', '5Km - Level Up'],
    otherText: [],
    backgroundDescription: 'A warm maroon-to-orange diagonal gradient with a faint Charminar silhouette.',
  };

  it('includes every transcribed text field verbatim, exactly once', () => {
    const prompt = buildDimensionRecompositionPrompt({
      transcription: fullTranscription,
      dimensionLabel: '4x5',
      targetWidth: 1080,
      targetHeight: 1350,
      includeSafeMargins: false,
    });
    expect(prompt).toContain('TIMES INTERNET HALF MARATHON');
    expect(prompt).toContain('"OCT 25." then "HYDERABAD\'S" then "RACE DAY."');
    expect(prompt).toContain('One start line, thousands of runners.');
    expect(prompt).toContain('Hyderabad | Oct 25, 2026');
    expect(prompt).toContain('REGISTER NOW');
    expect(prompt).toContain('3Km - Run For Fun');
    expect(prompt).toContain('Charminar');
    // Each headline occurrence should appear exactly once in the assembled prompt.
    expect(prompt.split("HYDERABAD'S").length - 1).toBe(1);
  });

  it('omits a text field entirely when the transcription says it is absent, rather than inventing placeholder text', () => {
    const prompt = buildDimensionRecompositionPrompt({
      transcription: { ...fullTranscription, ctaText: '', locationPillText: '' },
      dimensionLabel: '4x5',
      targetWidth: 1080,
      targetHeight: 1350,
      includeSafeMargins: false,
    });
    expect(prompt).not.toContain('CTA button:');
    expect(prompt).not.toContain('Location/date pill:');
  });

  it('always includes the hard no-stretch and no-duplicate-text constraints, for every dimension', () => {
    for (const dimensionLabel of ['9x16', '4x5', '1.91x1']) {
      const prompt = buildDimensionRecompositionPrompt({
        transcription: fullTranscription,
        dimensionLabel,
        targetWidth: 1000,
        targetHeight: 1000,
        includeSafeMargins: false,
      });
      expect(prompt).toContain('no stretching or distortion');
      expect(prompt).toContain('never repeat, duplicate, or re-use any word or line');
      expect(prompt).toContain('extra limbs');
    }
  });

  it('adds a top+bottom safe-margin block with correct pixel math for 9x16', () => {
    const prompt = buildDimensionRecompositionPrompt({
      transcription: fullTranscription,
      dimensionLabel: '9x16',
      targetWidth: 1080,
      targetHeight: 1920,
      includeSafeMargins: true,
    });
    // 12% of 1920 = 230.4 -> 230, 14% of 1920 = 268.8 -> 269
    expect(prompt).toContain('SAFE-ZONE REQUIREMENT');
    expect(prompt).toContain('top 230px');
    expect(prompt).toContain('bottom 269px');
    expect(prompt).toContain('y=230 to y=1651'); // 1920 - 269 = 1651
    expect(prompt).toContain('no text and no UI element of any kind in either band');
  });

  it('never adds the safe-margin block for 4x5 or 1.91x1', () => {
    for (const dimensionLabel of ['4x5', '1.91x1']) {
      const prompt = buildDimensionRecompositionPrompt({
        transcription: fullTranscription,
        dimensionLabel,
        targetWidth: 1080,
        targetHeight: 1350,
        includeSafeMargins: false,
      });
      expect(prompt).not.toContain('SAFE-ZONE REQUIREMENT');
    }
  });

  it('appends pipeline context (retry feedback or the boilerplate seed) as a neutral trailing note when present', () => {
    const prompt = buildDimensionRecompositionPrompt({
      transcription: fullTranscription,
      dimensionLabel: '9x16',
      targetWidth: 1080,
      targetHeight: 1920,
      includeSafeMargins: true,
      pipelineContext: 'Previous attempt feedback to address: the seam behind the headline was visible.',
    });
    expect(prompt).toContain('Additional context from the pipeline');
    expect(prompt).toContain('the seam behind the headline was visible');
  });

  it('real defect found live: adds a composition-balance instruction for taller-than-square targets (4x5, 9x16), so extra vertical space is not dumped into one empty gap', () => {
    for (const [dimensionLabel, width, height] of [
      ['4x5', 1080, 1350],
      ['9x16', 1080, 1920],
    ] as const) {
      const prompt = buildDimensionRecompositionPrompt({
        transcription: fullTranscription,
        dimensionLabel,
        targetWidth: width,
        targetHeight: height,
        includeSafeMargins: dimensionLabel === '9x16',
      });
      expect(prompt).toContain('COMPOSITION BALANCE');
      expect(prompt).toContain('do NOT concentrate all of the extra height into a single large empty gap');
    }
  });

  it('never adds the composition-balance instruction for 1.91x1 (wider, not taller, than the square source)', () => {
    const prompt = buildDimensionRecompositionPrompt({
      transcription: fullTranscription,
      dimensionLabel: '1.91x1',
      targetWidth: 1200,
      targetHeight: 630,
      includeSafeMargins: false,
    });
    expect(prompt).not.toContain('COMPOSITION BALANCE');
  });

  it('says no text elements were detected rather than fabricating any, when the transcription is empty', () => {
    const prompt = buildDimensionRecompositionPrompt({
      transcription: {
        logoText: '',
        headlineLines: [],
        subtextText: '',
        locationPillText: '',
        ctaText: '',
        statRowItems: [],
        otherText: [],
        backgroundDescription: '',
      },
      dimensionLabel: '4x5',
      targetWidth: 1080,
      targetHeight: 1350,
      includeSafeMargins: false,
    });
    expect(prompt).toContain('no text elements were detected');
    expect(prompt).toContain('match the existing background exactly');
  });
});
