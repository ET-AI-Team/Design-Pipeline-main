import { describe, it, expect } from 'bun:test';
import { getOrExtractStyle } from './render-poster';
import type { Job } from '@prisma/client';
import type { PosterStyleSpec } from '../providers/openai.client';

const NO_VISUAL_REF = { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } };

const CACHED_STYLE: PosterStyleSpec = {
  marginXRatio: 0.04,
  spacing: { logoToHeadlineGapRatio: 0.03, headlineToSubtextGapRatio: 0.015, afterTextBlockGapRatio: 0.02, ctaToTrustListGapRatio: 0.015 },
  headline: {
    lineCount: 3,
    align: 'center',
    lines: [
      { fontSizeRatio: 0.06, fontWeight: 700, styleDescription: 'bold display', color: { type: 'solid', color: '#fff' } },
      { fontSizeRatio: 0.06, fontWeight: 700, styleDescription: 'bold display', color: { type: 'solid', color: '#fff' } },
      { fontSizeRatio: 0.06, fontWeight: 700, styleDescription: 'bold display', color: { type: 'solid', color: '#fff' } },
    ],
    visualReference: NO_VISUAL_REF,
  },
  subtext: { present: false, fontSizeRatio: 0.02, fontWeight: 400, styleDescription: '', color: { type: 'solid', color: '#fff' }, align: 'left', visualReference: NO_VISUAL_REF },
  cta: {
    present: true, heightRatio: 0.1, cornerRadiusRatio: 0.02, fillColor: '#e11', labelTextColor: '#fff', labelFontWeight: 700,
    labelStyleDescription: '', hasPriceBand: false, priceBandColor: '', priceTextColor: '', priceFontWeight: 400, fontSizeRatio: 0.02,
    textAlign: 'center', textInsetRatio: 0.02, visualReference: NO_VISUAL_REF,
  },
  trustList: {
    present: false, itemCount: 0, layoutDescription: '', iconStyle: 'none', presentation: 'none', heightRatio: 0.03, cardWidthRatio: 0.2,
    cardCornerRadiusRatio: 0, backgroundColor: '', dividerColor: '', textColor: '', fontWeight: 400, fontSizeRatio: 0.012,
    checkmarkBadgeColor: '', checkmarkIconColor: '', checkmarkSizeRatio: 0.008, iconTextGapRatio: 0.005, iconOffsetRatio: 0.01,
    rowHeightRatio: 0.03, priceRowHeightRatio: 0.02, cardPaddingXRatio: 0.01, priceRow: { present: false, backgroundColor: '', textColor: '', fontWeight: 400 },
    promoBadge: { present: false, description: '' }, visualReference: NO_VISUAL_REF,
  },
  textColumnWidthRatio: 0.5,
  centerXRatio: 0.29,
  backgroundPattern: { present: false, word: '', containerDescription: '', styleDescription: '', color: { type: 'solid', color: '#fff' }, opacityRatio: 0 },
  otherElements: [],
  elementOrder: ['headline', 'cta'],
};

function fakeJob(styleSpecJson: object | null): Job {
  return {
    id: 'test-job-id',
    // Deliberately unreachable URLs - if getOrExtractStyle's reuse path
    // ever accidentally tried a real fetch, this test would hang/throw
    // instead of resolving, which is exactly the signal we want.
    reference2Url: 'https://example.invalid/should-not-be-fetched.png',
    baseAssetUrl: 'https://example.invalid/should-not-be-fetched-2.png',
    logoUrl: 'https://example.invalid/should-not-be-fetched-3.png',
    styleSpecJson,
  } as unknown as Job;
}

describe('getOrExtractStyle - cache reuse path', () => {
  it(
    'real bug found live: reuses a cached style with ZERO cost and no network call when nothing structural was flagged - previously this re-extracted fresh on every retry, letting a genuinely ambiguous read (does a CTA exist?) flip between attempts on the identical reference image',
    async () => {
      const job = fakeJob(CACHED_STYLE as unknown as object);
      const result = await getOrExtractStyle(job, { needsStructuralRecheck: false });
      expect(result.costInr).toBe(0);
      expect(result.style.headline.lineCount).toBe(3);
      expect(result.style.cta.present).toBe(true);
    },
    5000
  );

  it('still runs the reused style through clampStyle - a malformed cached value does not crash or pass through raw', async () => {
    const malformed = { ...CACHED_STYLE, marginXRatio: 999, headline: { ...CACHED_STYLE.headline, lineCount: -5 } };
    const job = fakeJob(malformed as unknown as object);
    const result = await getOrExtractStyle(job, { needsStructuralRecheck: false });
    expect(result.costInr).toBe(0);
    // clampStyle's real bounds (see render-poster.ts) - marginXRatio in [0.02, 0.08], lineCount in [1, 5].
    expect(result.style.marginXRatio).toBeLessThanOrEqual(0.08);
    expect(result.style.headline.lineCount).toBeGreaterThanOrEqual(1);
  });

  it('real bug found live: a genuinely extracted centerXRatio is used as-is, NOT overridden by the marginXRatio + textColumnWidthRatio/2 formula, even when the two disagree', async () => {
    // Deliberately far from marginXRatio(0.04) + textColumnWidthRatio(0.5)/2 = 0.29 -
    // this is the whole point: a reference whose subject sits below the
    // text (not beside it) has a true center nowhere near that formula.
    const styleWithRealCenter = { ...CACHED_STYLE, centerXRatio: 0.5 };
    const job = fakeJob(styleWithRealCenter as unknown as object);
    const result = await getOrExtractStyle(job, { needsStructuralRecheck: false });
    expect(result.style.centerXRatio).toBeCloseTo(0.5, 2);
  });

  it('falls back to the marginXRatio + textColumnWidthRatio/2 formula ONLY when centerXRatio is missing or malformed - never as the primary source', async () => {
    const { centerXRatio: _drop, ...withoutCenter } = CACHED_STYLE as unknown as Record<string, unknown>;
    const job = fakeJob(withoutCenter as object);
    const result = await getOrExtractStyle(job, { needsStructuralRecheck: false });
    // CACHED_STYLE: marginXRatio 0.04, textColumnWidthRatio 0.5 -> fallback 0.29.
    expect(result.style.centerXRatio).toBeCloseTo(0.29, 2);
  });
});
