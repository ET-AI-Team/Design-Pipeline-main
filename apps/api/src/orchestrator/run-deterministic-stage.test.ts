import { describe, it, expect } from 'bun:test';
import { mergeCopyWithPrevious, buildRetryFeedback, capScoreIfAnyFieldFailed, type PosterLayerBreakdown } from './run-deterministic-stage';
import { QA_PASS_THRESHOLD } from './handle-stage-result';
import type { AdCopy, PosterStyleSpec, PosterVerificationFields } from '../providers/openai.client';

const PASS = { reasoning: 'looks correct', pass: true };
const FAIL = (reasoning: string) => ({ reasoning, pass: false });

const ALL_PASS_FIELDS: PosterVerificationFields = {
  headline: PASS,
  subtext: PASS,
  cta: PASS,
  otherElements: PASS,
  photoAndLogo: PASS,
  noExtraDecoration: PASS,
  legibility: PASS,
  alignment: PASS,
};

const PREV_COPY: AdCopy = {
  headlineLines: ['How far will you really go', 'to WIN?'],
  subtext: 'Chase your fastest PB yet on Pune’s speed course.',
  ctaLabel: 'REGISTER NOW',
  priceText: undefined,
  trustItems: [],
  promoBadgeText: undefined,
  otherElementTexts: ['PUNE', '8 MAR 2026'],
};

const FRESH_COPY: AdCopy = {
  headlineLines: ['How far can you push', 'your LIMITS?'],
  subtext: 'Chase your personal best on Pune’s fastest route.',
  ctaLabel: 'JOIN NOW',
  priceText: undefined,
  trustItems: [],
  promoBadgeText: undefined,
  otherElementTexts: ['PUNE', '8 MARCH 2026'],
};

const STYLE: PosterStyleSpec = {
  marginXRatio: 0.04,
  spacing: { logoToHeadlineGapRatio: 0.03, headlineToSubtextGapRatio: 0.015, afterTextBlockGapRatio: 0.02, ctaToTrustListGapRatio: 0.015 },
  headline: { lineCount: 2, align: 'left', lines: [], visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } } },
  subtext: { present: true, fontSizeRatio: 0.02, fontWeight: 500, styleDescription: '', color: { type: 'solid', color: '#fff' }, align: 'left', visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } } },
  cta: {
    present: true, heightRatio: 0.1, cornerRadiusRatio: 0.02, fillColor: '#fff', labelTextColor: '#000', labelFontWeight: 700,
    labelStyleDescription: '', hasPriceBand: false, priceBandColor: '', priceTextColor: '', priceFontWeight: 400, fontSizeRatio: 0.02,
    textAlign: 'center', textInsetRatio: 0.02, visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } },
  },
  trustList: {
    present: false, itemCount: 0, layoutDescription: '', iconStyle: 'none', presentation: 'none', heightRatio: 0.03, cardWidthRatio: 0.2,
    cardCornerRadiusRatio: 0, backgroundColor: '', dividerColor: '', textColor: '', fontWeight: 400, fontSizeRatio: 0.012,
    checkmarkBadgeColor: '', checkmarkIconColor: '', checkmarkSizeRatio: 0.008, iconTextGapRatio: 0.005, iconOffsetRatio: 0.01,
    rowHeightRatio: 0.03, priceRowHeightRatio: 0.02, cardPaddingXRatio: 0.01, priceRow: { present: false, backgroundColor: '', textColor: '', fontWeight: 400 },
    promoBadge: { present: false, description: '' }, visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } },
  },
  textColumnWidthRatio: 0.5,
  centerXRatio: 0.29,
  otherElements: [],
  elementOrder: ['headline', 'subtext', 'cta'],
};

describe('mergeCopyWithPrevious', () => {
  it('returns the fresh copy unchanged on the first attempt (no previous)', () => {
    expect(mergeCopyWithPrevious(FRESH_COPY, null, STYLE)).toEqual(FRESH_COPY);
  });

  it('real bug found live: pins a field that already PASSED to its exact previous value, even though a fresh version was generated - a real job regenerated a brand-new, different headline on retry despite the headline having already passed, and the rendered image ended up mixing old and new text', () => {
    const previous: PosterLayerBreakdown = {
      style: STYLE,
      adCopy: PREV_COPY,
      fields: { ...ALL_PASS_FIELDS, subtext: FAIL('subtext wording drifted from the requested text') },
    };
    const merged = mergeCopyWithPrevious(FRESH_COPY, previous, STYLE);
    // Headline passed last time - must stay exactly as it was, not the freshly generated version.
    expect(merged.headlineLines).toEqual(PREV_COPY.headlineLines);
    expect(merged.headlineLines).not.toEqual(FRESH_COPY.headlineLines);
    // Subtext failed - the fresh, hopefully-fixed version is used.
    expect(merged.subtext).toBe(FRESH_COPY.subtext);
  });

  it('pins otherElementTexts/trustItems/promoBadgeText together under the otherElements field', () => {
    const previous: PosterLayerBreakdown = {
      style: STYLE,
      adCopy: PREV_COPY,
      fields: { ...ALL_PASS_FIELDS, otherElements: FAIL('date format did not match') },
    };
    const merged = mergeCopyWithPrevious(FRESH_COPY, previous, STYLE);
    expect(merged.otherElementTexts).toEqual(FRESH_COPY.otherElementTexts);
  });

  it('ties priceText to the cta field when the CTA has a price band, not to otherElements', () => {
    const styleWithPriceBand: PosterStyleSpec = { ...STYLE, cta: { ...STYLE.cta, hasPriceBand: true } };
    const prevWithPrice: AdCopy = { ...PREV_COPY, priceText: 'From ₹299' };
    const freshWithPrice: AdCopy = { ...FRESH_COPY, priceText: 'From ₹199' };
    const previous: PosterLayerBreakdown = {
      style: styleWithPriceBand,
      adCopy: prevWithPrice,
      fields: { ...ALL_PASS_FIELDS, cta: FAIL('price text mismatch'), otherElements: PASS },
    };
    const merged = mergeCopyWithPrevious(freshWithPrice, previous, styleWithPriceBand);
    // cta failed (which governs priceText here, since hasPriceBand is true) -> fresh price used.
    expect(merged.priceText).toBe(freshWithPrice.priceText);
  });

  it('when the CTA has no price band, ties priceText to otherElements instead (the trust-list price-row case)', () => {
    const prevWithPrice: AdCopy = { ...PREV_COPY, priceText: 'From ₹299' };
    const freshWithPrice: AdCopy = { ...FRESH_COPY, priceText: 'From ₹199' };
    const previous: PosterLayerBreakdown = {
      style: STYLE, // hasPriceBand: false
      adCopy: prevWithPrice,
      fields: { ...ALL_PASS_FIELDS, cta: FAIL('unrelated cta issue'), otherElements: PASS },
    };
    const merged = mergeCopyWithPrevious(freshWithPrice, previous, STYLE);
    // otherElements passed (which governs priceText here) -> previous price pinned, even though cta itself failed.
    expect(merged.priceText).toBe(prevWithPrice.priceText);
  });
});

describe('buildRetryFeedback', () => {
  it('returns undefined when every field passed (nothing to fix)', () => {
    expect(buildRetryFeedback(ALL_PASS_FIELDS)).toBeUndefined();
  });

  it('real bug found live: names only the failed field(s), never quotes or restates a field that already passed', () => {
    const fields: PosterVerificationFields = { ...ALL_PASS_FIELDS, headline: FAIL('headline text did not match') };
    const feedback = buildRetryFeedback(fields);
    expect(feedback).toContain('Headline: headline text did not match');
    // None of the passing fields' names should appear as something to fix.
    expect(feedback).not.toContain('Subtext:');
    expect(feedback).not.toContain('CTA:');
    expect(feedback).not.toContain('Photo/logo:');
  });

  it('names every failed field when more than one fails', () => {
    const fields: PosterVerificationFields = {
      ...ALL_PASS_FIELDS,
      headline: FAIL('headline mismatch'),
      legibility: FAIL('text overlaps the subject'),
    };
    const feedback = buildRetryFeedback(fields);
    expect(feedback).toContain('Headline: headline mismatch');
    expect(feedback).toContain('Legibility/layout: text overlaps the subject');
  });

  it('tells the model to leave everything else unchanged', () => {
    const fields: PosterVerificationFields = { ...ALL_PASS_FIELDS, cta: FAIL('cta text wrong') };
    expect(buildRetryFeedback(fields)).toContain('every other element in this design already matched what was asked and must render EXACTLY the same as before, completely unchanged');
  });

  it('real bug found live: names an alignment-only failure even though it is not a copy field - a real job rendered with inconsistent, neither-left-nor-center positioning and nothing flagged it', () => {
    const fields: PosterVerificationFields = { ...ALL_PASS_FIELDS, alignment: FAIL('lines are inconsistently positioned, neither sharing a left edge nor a center') };
    const feedback = buildRetryFeedback(fields);
    expect(feedback).toContain('Alignment: lines are inconsistently positioned, neither sharing a left edge nor a center');
  });
});

describe('capScoreIfAnyFieldFailed', () => {
  it('passes the aggregate score through unchanged when every field passed', () => {
    const result = capScoreIfAnyFieldFailed(ALL_PASS_FIELDS, 9);
    expect(result.effectiveQaScore).toBe(9);
    expect(result.wouldHaveSilentlyPassed).toBe(false);
  });

  it('real bug found live: caps the score below the pass threshold when a field failed, even if the model gave a high aggregate score - a real job\'s promo badge showed the wrong text while the aggregate score alone would have passed', () => {
    const fields: PosterVerificationFields = { ...ALL_PASS_FIELDS, otherElements: FAIL('promo badge text does not match') };
    const result = capScoreIfAnyFieldFailed(fields, 8); // 8 would normally clear QA_PASS_THRESHOLD
    expect(result.effectiveQaScore).toBeLessThan(QA_PASS_THRESHOLD);
    expect(result.wouldHaveSilentlyPassed).toBe(true);
  });

  it('does not flag wouldHaveSilentlyPassed when the aggregate score was already going to fail anyway', () => {
    const fields: PosterVerificationFields = { ...ALL_PASS_FIELDS, headline: FAIL('headline mismatch') };
    const result = capScoreIfAnyFieldFailed(fields, 2); // already below threshold regardless
    expect(result.effectiveQaScore).toBeLessThan(QA_PASS_THRESHOLD);
    expect(result.wouldHaveSilentlyPassed).toBe(false);
  });
});
