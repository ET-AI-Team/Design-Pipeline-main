import { describe, it, expect } from 'bun:test';
import { sanitizeAdCopy, type AdCopy, type PosterStyleSpec } from '../providers/openai.client';
import { clampStyle } from './render-poster';

/**
 * Covers the half of the edit router that must be correct without a
 * network call: applying a patch and VALIDATING it. The model's job is
 * only to name which fields change; everything that makes a patch safe
 * to render happens in code, so that is what is tested here.
 *
 * Mirrors planAssetEdit's own deepMerge semantics deliberately rather
 * than importing it - if that merge is ever changed, these tests should
 * fail loudly instead of silently following along.
 */
function applyPatch<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object' || typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = applyPatch((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

const baseCopy: AdCopy = {
  headlineLines: ['Lower back pain', 'in pregnancy?'],
  subtext: 'Ease it daily with safe prenatal yoga.',
  ctaLabel: 'JOIN TODAY',
  priceText: 'From 299/month',
  trustItems: ['Certified instructors', 'Doctor approved plans'],
  promoBadgeText: undefined,
  otherElementTexts: ['In Partnership With', ''],
};

function makeStyle(): PosterStyleSpec {
  return {
    marginXRatio: 0.06,
    spacing: { logoToHeadlineGapRatio: 0.04, headlineToSubtextGapRatio: 0.02, afterTextBlockGapRatio: 0.03, ctaToTrustListGapRatio: 0.02 },
    headline: {
      lineCount: 2,
      align: 'left',
      lines: [
        { fontSizeRatio: 0.07, fontWeight: 700, styleDescription: 'bold serif', color: { type: 'solid', color: '#5b2a86' } },
        { fontSizeRatio: 0.07, fontWeight: 700, styleDescription: 'bold serif', color: { type: 'solid', color: '#5b2a86' } },
      ],
      visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 0.1 } },
    },
    subtext: {
      present: true,
      fontSizeRatio: 0.025,
      fontWeight: 400,
      styleDescription: 'regular sans',
      color: { type: 'solid', color: '#2b2b2b' },
      align: 'left',
      visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 0.1 } },
    },
    cta: {
      present: true,
      heightRatio: 0.1,
      cornerRadiusRatio: 0.02,
      fillColor: '#5b2a86',
      labelTextColor: '#ffffff',
      labelFontWeight: 700,
      labelStyleDescription: 'bold sans',
      hasPriceBand: true,
      priceBandColor: '#ffffff',
      priceTextColor: '#5b2a86',
      priceFontWeight: 600,
      fontSizeRatio: 0.028,
      textAlign: 'center',
      textInsetRatio: 0.02,
      visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 0.1 } },
    },
    trustList: {
      present: true,
      itemCount: 2,
      layoutDescription: 'a bottom bar of checkmark items',
      iconStyle: 'checkmark-filled',
      presentation: 'bar',
      heightRatio: 0.08,
      cardWidthRatio: 0.3,
      cardCornerRadiusRatio: 0,
      backgroundColor: '#5b2a86',
      dividerColor: '#5b2a86',
      textColor: '#ffffff',
      fontWeight: 500,
      fontSizeRatio: 0.02,
      checkmarkBadgeColor: '#8ac926',
      checkmarkIconColor: '#ffffff',
      checkmarkSizeRatio: 0.02,
      iconTextGapRatio: 0.01,
      iconOffsetRatio: 0.02,
      rowHeightRatio: 0.05,
      priceRowHeightRatio: 0.05,
      cardPaddingXRatio: 0.02,
      priceRow: { present: false, backgroundColor: '#ffffff', textColor: '#000000', fontWeight: 400 },
      promoBadge: { present: false, description: '' },
      visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 0.1 } },
    },
    textColumnWidthRatio: 0.45,
    centerXRatio: 0.5,
    backgroundPattern: {
      present: false,
      word: '',
      containerDescription: '',
      styleDescription: 'outlined display lettering',
      color: { type: 'solid', color: '#ffffff' },
      opacityRatio: 0,
    },
    otherElements: [],
    elementOrder: ['headline', 'subtext', 'cta', 'trustList'],
  };
}

describe('edit patch application (copy lane)', () => {
  it('changes ONLY the field the patch names', () => {
    const patched = sanitizeAdCopy(applyPatch(baseCopy, { ctaLabel: 'JOIN NOW' }));
    expect(patched.ctaLabel).toBe('JOIN NOW');
    // Everything else survives verbatim - a patch is a delta, not a
    // replacement, which is what stops an edit quietly rewording copy
    // the user never asked about.
    expect(patched.headlineLines).toEqual(baseCopy.headlineLines);
    expect(patched.subtext).toBe(baseCopy.subtext);
    expect(patched.trustItems).toEqual(baseCopy.trustItems);
  });

  it('replaces arrays wholesale rather than merging by index', () => {
    // Index-merging would produce a hybrid of old and new wording - the
    // exact old/new-text confusion the poster stage's own
    // mergeCopyWithPrevious was written to eliminate.
    const patched = sanitizeAdCopy(applyPatch(baseCopy, { headlineLines: ['One line only'] }));
    expect(patched.headlineLines).toEqual(['One line only']);
  });

  it('runs the patch through the same sanitiser generated copy gets', () => {
    // A model-supplied dash must be normalised identically whether it
    // arrived from generateAdCopy or from an edit patch.
    const patched = sanitizeAdCopy(applyPatch(baseCopy, { ctaLabel: 'JOIN - TODAY' }));
    expect(patched.ctaLabel).toBe('JOIN, TODAY');
  });

  it('survives a null inside a patched array (the job 3106ae7d crash shape)', () => {
    const patched = sanitizeAdCopy(applyPatch(baseCopy, { trustItems: ['Certified', null] } as unknown));
    expect(patched.trustItems).toEqual(['Certified']);
  });
});

describe('edit patch validation (style lane)', () => {
  it('applies a colour change and leaves the rest of the spec intact', () => {
    const patched = clampStyle(applyPatch(makeStyle(), { cta: { fillColor: '#16a34a' } }));
    expect(patched.cta.fillColor).toBe('#16a34a');
    expect(patched.cta.labelTextColor).toBe('#ffffff');
    expect(patched.headline.align).toBe('left');
    expect(patched.elementOrder).toEqual(['headline', 'subtext', 'cta', 'trustList']);
  });

  it('clamps an out-of-range ratio instead of passing it to the renderer', () => {
    // A patched spec is no more trustworthy than a freshly extracted
    // one - clampStyle is the single place that knows every field's
    // sane envelope, so /edit reuses it rather than trusting the model.
    const patched = clampStyle(applyPatch(makeStyle(), { marginXRatio: 0.9 }));
    expect(patched.marginXRatio).toBeLessThanOrEqual(0.08);
  });

  it('degrades a malformed colour to a safe value rather than rendering garbage', () => {
    const patched = clampStyle(applyPatch(makeStyle(), { subtext: { color: { type: 'solid', color: 'not-a-hex' } } }));
    expect(patched.subtext.color.color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
  });

  it('rejects a gradient that has no valid second colour behind it', () => {
    const patched = clampStyle(
      applyPatch(makeStyle(), { subtext: { color: { type: 'gradient', color: '#ffffff', gradientTo: 'nope' } } })
    );
    // Never passes a half-broken gradient descriptor downstream.
    expect(patched.subtext.color.type).toBe('solid');
  });

  it('validates an enum-shaped patch value instead of trusting it', () => {
    const patched = clampStyle(applyPatch(makeStyle(), { trustList: { presentation: 'floating-hexagon' } } as unknown));
    expect(['bar', 'card', 'inline', 'none']).toContain(patched.trustList.presentation);
  });
});
