import type { Job } from '@prisma/client';
import { analyzeReferenceStyle, type ColorSpec, type HeadlineLineStyle, type PosterStyleSpec, type VisualReferenceHint } from '../providers/openai.client';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s);
}
function safeColor(color: unknown, fallback: string): string {
  return isHexColor(color) ? color : fallback;
}

function nonEmptyString(s: unknown, fallback: string): string {
  return typeof s === 'string' && s.trim().length > 0 ? s : fallback;
}

const FALLBACK_BRAND_COLOR = '#1a2a5e'; // only used if the AI returns an unparseable color for something load-bearing

/** Never trusts a gradient claim without a valid pair of colors backing
 *  it - a malformed `gradientTo` (missing, not a real hex) silently
 *  degrades to a solid fill using whatever real color was extracted,
 *  rather than passing a broken gradient descriptor downstream into the
 *  prompt. */
function clampColorSpec(raw: Partial<ColorSpec> | null | undefined, fallback: string): ColorSpec {
  const color = safeColor(raw?.color, fallback);
  if (raw?.type === 'gradient' && isHexColor(raw.gradientTo)) {
    const direction: ColorSpec['gradientDirection'] =
      raw.gradientDirection === 'vertical' || raw.gradientDirection === 'diagonal' ? raw.gradientDirection : 'horizontal';
    return { type: 'gradient', color, gradientTo: raw.gradientTo, gradientDirection: direction };
  }
  return { type: 'solid', color };
}

function clampHeadlineLine(raw: Partial<HeadlineLineStyle> | undefined): HeadlineLineStyle {
  return {
    fontSizeRatio: clamp(raw?.fontSizeRatio ?? NaN, 0.03, 0.11),
    fontWeight: clamp(raw?.fontWeight ?? NaN, 400, 900),
    styleDescription: nonEmptyString(raw?.styleDescription, 'bold, clean sans-serif display type'),
    color: clampColorSpec(raw?.color, FALLBACK_BRAND_COLOR),
  };
}

const VALID_ICON_STYLES = new Set(['checkmark-filled', 'checkmark-outline', 'flat-checkmark', 'bullet-dot', 'custom', 'none']);
const VALID_PRESENTATIONS = new Set(['bar', 'card', 'inline', 'none']);

function clampOtherElementPart(
  raw: Partial<{ text: string | null; hasText: boolean; styleDescription: string; color: Partial<ColorSpec> }> | undefined
): { text: string | null; hasText: boolean; styleDescription: string; color: ColorSpec } {
  return {
    text: typeof raw?.text === 'string' && raw.text.trim().length > 0 ? raw.text : null,
    hasText: !!raw?.hasText,
    styleDescription: nonEmptyString(raw?.styleDescription, 'plain sans-serif text'),
    color: clampColorSpec(raw?.color, '#ffffff'),
  };
}

/** Never trusts `recommended: true` without a box that can actually back
 *  a real crop - same "never trust a flag without the data behind it"
 *  discipline as clampColorSpec's gradient-without-gradientTo handling.
 *  A degenerate box (near-zero size, out of [0,1] bounds) forces
 *  recommended back to false regardless of what the AI said, rather
 *  than passing a box downstream that would crop garbage or throw. */
function clampVisualReferenceHint(raw: Partial<VisualReferenceHint> | undefined): VisualReferenceHint {
  const box = raw?.box;
  const validBox =
    !!box &&
    Number.isFinite(box.xRatio) &&
    Number.isFinite(box.yRatio) &&
    Number.isFinite(box.widthRatio) &&
    Number.isFinite(box.heightRatio) &&
    box.widthRatio > 0.01 &&
    box.heightRatio > 0.01 &&
    box.xRatio >= 0 &&
    box.yRatio >= 0 &&
    box.xRatio + box.widthRatio <= 1.01 &&
    box.yRatio + box.heightRatio <= 1.01;
  return {
    recommended: !!raw?.recommended && validBox,
    box: validBox
      ? {
          xRatio: clamp(box!.xRatio, 0, 1),
          yRatio: clamp(box!.yRatio, 0, 1),
          widthRatio: clamp(box!.widthRatio, 0.01, 1),
          heightRatio: clamp(box!.heightRatio, 0.01, 1),
        }
      : { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 },
  };
}

const ELEMENT_NAME_PATTERN = /^(headline|subtext|cta|trustList|otherElements\[\d+\])$/;

/** The order this pipeline rendered blocks in before elementOrder
 *  existed - used as the fallback when the AI's elementOrder is
 *  missing/malformed, so nothing silently disappears from the prompt.
 *  Never used to override a real elementOrder the extraction did
 *  provide - only a defensive backstop. */
function naturalElementOrder(subtextPresent: boolean, ctaPresent: boolean, trustListPresent: boolean, otherElementCount: number): string[] {
  const order = ['headline'];
  if (subtextPresent) order.push('subtext');
  if (ctaPresent) order.push('cta');
  if (trustListPresent) order.push('trustList');
  for (let i = 0; i < otherElementCount; i++) order.push(`otherElements[${i}]`);
  return order;
}

/** The reference-style analysis is a vision call estimating proportions
 *  and structure by eye, not a pixel measurement - clamps AI estimates
 *  to a sane envelope rather than trusting an outlier straight into the
 *  layout. The center of each range is never used as a default - only
 *  as a bound on the real per-job extracted value. Freeform description
 *  fields (styleDescription, layoutDescription, promoBadge.description)
 *  are never range-clamped - clamping only applies to numbers - but do
 *  get a defensive non-empty fallback, same principle as
 *  base_layer_classification's compositionGuide validation. */
function clampStyle(raw: PosterStyleSpec): PosterStyleSpec {
  const headlineLineCount = Math.round(clamp(raw.headline.lineCount, 1, 5));
  const subtextPresent = !!raw.subtext?.present;
  const ctaPresent = !!raw.cta?.present;
  const trustListPresent = !!raw.trustList?.present;
  const otherElements = Array.isArray(raw.otherElements)
    ? raw.otherElements.map((el) => ({
        description: nonEmptyString(el?.description, 'a small design element'),
        positionDescription: nonEmptyString(el?.positionDescription, 'near the top of the composition'),
        // Never trust an enum-shaped value without checking it - same
        // discipline as headline.align/subtext.align below. Defaults to
        // 'left' on a malformed value, matching those same fields' own
        // fallback.
        align: (el?.align === 'center' ? 'center' : 'left') as 'left' | 'center',
        approxYRatio: clamp(el?.approxYRatio ?? NaN, 0.05, 0.95),
        approxHeightRatio: clamp(el?.approxHeightRatio ?? NaN, 0.02, 0.15),
        gapAboveRatio: clamp(el?.gapAboveRatio ?? NaN, 0.005, 0.08),
        parts: Array.isArray(el?.parts) && el.parts.length > 0 ? el.parts.map(clampOtherElementPart) : [clampOtherElementPart(undefined)],
        visualReference: clampVisualReferenceHint(el?.visualReference),
      }))
    : [];
  const fallbackElementOrder = naturalElementOrder(subtextPresent, ctaPresent, trustListPresent, otherElements.length);
  const elementOrder =
    Array.isArray(raw.elementOrder) && raw.elementOrder.length > 0 && raw.elementOrder.every((n) => typeof n === 'string' && ELEMENT_NAME_PATTERN.test(n))
      ? raw.elementOrder
      : fallbackElementOrder;
  return {
    marginXRatio: clamp(raw.marginXRatio, 0.02, 0.08),
    spacing: {
      logoToHeadlineGapRatio: clamp(raw.spacing.logoToHeadlineGapRatio, 0.01, 0.1),
      headlineToSubtextGapRatio: clamp(raw.spacing.headlineToSubtextGapRatio, 0.005, 0.06),
      afterTextBlockGapRatio: clamp(raw.spacing.afterTextBlockGapRatio, 0.01, 0.08),
      ctaToTrustListGapRatio: clamp(raw.spacing.ctaToTrustListGapRatio, 0, 0.06),
    },
    headline: {
      lineCount: headlineLineCount,
      align: raw.headline.align === 'center' ? 'center' : 'left',
      // Always exactly headlineLineCount entries, defensively - never
      // trust the AI's array to be the right length, same "never crash
      // on a length mismatch downstream" discipline as everywhere else
      // in this pipeline.
      lines: Array.from({ length: headlineLineCount }, (_, i) => clampHeadlineLine(raw.headline.lines?.[i])),
      visualReference: clampVisualReferenceHint(raw.headline.visualReference),
    },
    subtext: {
      present: subtextPresent,
      fontSizeRatio: clamp(raw.subtext?.fontSizeRatio ?? NaN, 0.014, 0.04),
      fontWeight: clamp(raw.subtext?.fontWeight ?? NaN, 400, 900),
      styleDescription: nonEmptyString(raw.subtext?.styleDescription, 'clean regular-weight sans-serif'),
      color: clampColorSpec(raw.subtext?.color, '#2b2b2b'),
      align: raw.subtext?.align === 'center' ? 'center' : 'left',
      visualReference: clampVisualReferenceHint(raw.subtext?.visualReference),
    },
    cta: {
      ...raw.cta,
      heightRatio: clamp(raw.cta.heightRatio, 0.06, 0.22),
      cornerRadiusRatio: clamp(raw.cta.cornerRadiusRatio, 0, 0.05),
      fontSizeRatio: clamp(raw.cta.fontSizeRatio, 0.016, 0.035),
      labelFontWeight: clamp(raw.cta.labelFontWeight, 400, 900),
      labelStyleDescription: nonEmptyString(raw.cta.labelStyleDescription, 'bold sans-serif'),
      priceFontWeight: clamp(raw.cta.priceFontWeight, 400, 900),
      textInsetRatio: clamp(raw.cta.textInsetRatio, 0.008, 0.06),
      // Real bug found live: textAlign was extracted but never
      // validated (passed through raw via the ...raw.cta spread above)
      // - same defensive "never trust an enum-shaped value without
      // checking it" discipline as headline.align/subtext.align.
      textAlign: raw.cta.textAlign === 'center' ? 'center' : 'left',
      visualReference: clampVisualReferenceHint(raw.cta?.visualReference),
    },
    trustList: {
      ...raw.trustList,
      present: trustListPresent,
      itemCount: Math.round(clamp(raw.trustList.itemCount, 0, 6)),
      layoutDescription: nonEmptyString(raw.trustList.layoutDescription, 'a simple horizontal list of short text items'),
      iconStyle: VALID_ICON_STYLES.has(raw.trustList.iconStyle) ? raw.trustList.iconStyle : 'none',
      presentation: VALID_PRESENTATIONS.has(raw.trustList.presentation) ? raw.trustList.presentation : 'none',
      heightRatio: clamp(raw.trustList.heightRatio, 0.03, 0.12),
      cardWidthRatio: clamp(raw.trustList.cardWidthRatio, 0.2, 0.55),
      cardCornerRadiusRatio: clamp(raw.trustList.cardCornerRadiusRatio, 0, 0.05),
      fontSizeRatio: clamp(raw.trustList.fontSizeRatio, 0.012, 0.03),
      fontWeight: clamp(raw.trustList.fontWeight, 400, 900),
      checkmarkSizeRatio: clamp(raw.trustList.checkmarkSizeRatio, 0.008, 0.035),
      iconTextGapRatio: clamp(raw.trustList.iconTextGapRatio, 0.005, 0.04),
      iconOffsetRatio: clamp(raw.trustList.iconOffsetRatio, 0.01, 0.08),
      rowHeightRatio: clamp(raw.trustList.rowHeightRatio, 0.03, 0.1),
      priceRowHeightRatio: clamp(raw.trustList.priceRowHeightRatio, 0.02, 0.09),
      cardPaddingXRatio: clamp(raw.trustList.cardPaddingXRatio, 0.01, 0.06),
      priceRow: { ...raw.trustList.priceRow, fontWeight: clamp(raw.trustList.priceRow.fontWeight, 400, 900) },
      promoBadge: {
        present: !!raw.trustList.promoBadge?.present,
        description: nonEmptyString(raw.trustList.promoBadge?.description, 'a small promotional badge'),
      },
      visualReference: clampVisualReferenceHint(raw.trustList?.visualReference),
    },
    textColumnWidthRatio: clamp(raw.textColumnWidthRatio, 0.25, 0.55),
    // Real defect found live: centered content used to be anchored on
    // marginXRatio + textColumnWidthRatio/2 - a formula built for a
    // DIFFERENT purpose (keeping text off a side-by-side photo subject)
    // that gave a real, measured ~15-point-wrong answer for a reference
    // where the subject sits BELOW the text instead (text spans close
    // to the full canvas, true center ~50%; the column formula computed
    // ~35%, and the edit model followed that wrong number faithfully).
    // Read directly now (see the field's own doc comment in
    // openai.client.ts) - the column formula is kept ONLY as a
    // defensive fallback for a missing/malformed extracted value, never
    // as the primary source.
    centerXRatio: Number.isFinite(raw.centerXRatio)
      ? clamp(raw.centerXRatio, 0.15, 0.85)
      : clamp((Number.isFinite(raw.marginXRatio) ? raw.marginXRatio : 0.04) + (Number.isFinite(raw.textColumnWidthRatio) ? raw.textColumnWidthRatio : 0.35) / 2, 0.15, 0.85),
    otherElements,
    elementOrder,
  };
}

/**
 * Style extraction is a vision call against the user's own reference
 * (content/hierarchy/structure), the real current composite (for size
 * ratios that actually fit the real canvas), and the real logo file
 * (so a repeated brand wordmark elsewhere in the reference can be
 * recognized and excluded, not extracted as fresh content) - see
 * analyzeReferenceStyle's own doc comment.
 *
 * Real, confirmed-live bug this fixes: this used to re-extract fresh on
 * every single retry within a job, with zero memory of the previous
 * read - a genuinely ambiguous structural call (does a CTA button
 * really exist here, or is it just a labeled banner?) flipped between
 * attempts on the IDENTICAL reference image, so a real job's CTA
 * appeared, then vanished, then relocated into an unrelated badge
 * across three tries. Now three-tiered, cheapest-first:
 *  1. No cached style yet (first real attempt on this job) -> fresh
 *     read, same as always.
 *  2. A cached style exists AND nothing about the LAST attempt suggested
 *     the structure itself was wrong -> reuse it verbatim, no vision
 *     call at all - cheaper and, more importantly, no chance to
 *     accidentally disagree with an already-good read.
 *  3. A cached style exists AND the last attempt's own verification
 *     flagged something structural (a CTA or otherElements mismatch,
 *     the two fields a wrong structural read would actually show up in)
 *     -> re-check, but ANCHORED on the previous answer (see
 *     analyzeReferenceStyle's previousStyle param) - confirm-or-correct,
 *     not a blind re-guess from zero.
 * The caller (run-deterministic-stage.ts's runPosterStage) is
 * responsible for persisting whatever style comes out of this back onto
 * Job.styleSpecJson so the next attempt, if any, can read it back in.
 */
export async function getOrExtractStyle(
  job: Job,
  options?: { needsStructuralRecheck: boolean }
): Promise<{ style: PosterStyleSpec; costInr: number }> {
  const cached = job.styleSpecJson as unknown as PosterStyleSpec | null;

  if (cached && !options?.needsStructuralRecheck) {
    return { style: clampStyle(cached), costInr: 0 };
  }

  const result = await analyzeReferenceStyle({
    referenceImageUrl: job.reference2Url,
    currentCompositeUrl: job.baseAssetUrl!,
    logoUrl: job.logoUrl,
    previousStyle: cached ?? undefined,
  });
  return { style: clampStyle(result.style), costInr: result.costInr };
}
