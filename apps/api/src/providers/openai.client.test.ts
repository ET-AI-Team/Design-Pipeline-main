import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { stripDashes, stripDashesFromLines } from './openai.client';

describe('stripDashes', () => {
  it('replaces a mid-sentence hyphen with a comma', () => {
    expect(stripDashes('Relief - fast and easy')).toBe('Relief, fast and easy');
  });

  it('replaces an em-dash the same way (real generated output has used one)', () => {
    expect(stripDashes('Daily stretches for lasting relief—at your desk.')).toBe('Daily stretches for lasting relief, at your desk.');
  });

  it('removes a leading/trailing dash without leaving a stray comma', () => {
    expect(stripDashes('-Start Now-')).toBe('Start Now');
  });

  it('leaves text with no dash untouched', () => {
    expect(stripDashes('Ease Neck & Shoulder Pain')).toBe('Ease Neck & Shoulder Pain');
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
