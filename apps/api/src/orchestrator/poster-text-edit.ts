import sharp from 'sharp';
import { editPosterImage, type AdCopy, type ColorSpec, type PosterStyleSpec, type BaseLayerSpec, type ReferenceBox } from '../providers/openai.client';

export interface ExclusionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Concrete pixel size alongside the percentage - a literal number is a
 *  stronger target for an image-generation model to hit than an
 *  abstract ratio alone. Always measured against canvas WIDTH, matching
 *  every fontSizeRatio field's own convention. */
function pxOfWidth(ratio: number, canvasW: number): number {
  return Math.round(ratio * canvasW);
}

/** The real subject-overlap boundary - marginXRatio + textColumnWidthRatio,
 *  measured from canvas x=0 rightward. Computed once, shared by both
 *  the main layout statement and the closing "Do NOT" bookend, so the
 *  two mentions can never disagree with each other on the actual
 *  number. See styleInstructionsBlock's own doc comment for why this
 *  exists - textColumnWidthRatio used to be extracted and never read. */
function textColumnBoundary(style: PosterStyleSpec, canvasW: number): { pctLabel: string; px: number } {
  const ratio = style.marginXRatio + style.textColumnWidthRatio;
  return { pctLabel: pct(ratio), px: pxOfWidth(ratio, canvasW) };
}

/** Deterministic, code-computed comparison - never a second, possibly-
 *  disagreeing AI judgment about relative size. Same "derive one number
 *  from another in code" principle as clampStyle's own checkmark-size-
 *  vs-row-height relationship. Comparing two elements being generated in
 *  the SAME call is a far easier target for an image model to hit than
 *  each element's isolated percentage alone - confirmed by a real
 *  defect: a correctly-identified headline still rendered visibly
 *  smaller than the reference despite a numerically correct ratio,
 *  because nothing anchored it against anything else in the same image.
 */
function relativeSizeSentence(style: PosterStyleSpec): string | null {
  const headlineRatio = Math.max(...style.headline.lines.map((l) => l.fontSizeRatio));
  if (headlineRatio <= 0) return null;
  const comparisons: string[] = [];
  if (style.subtext.present && style.subtext.fontSizeRatio > 0) {
    comparisons.push(`roughly ${(headlineRatio / style.subtext.fontSizeRatio).toFixed(1)}x the size of the subtext`);
  }
  if (style.cta.present && style.cta.fontSizeRatio > 0) {
    comparisons.push(`roughly ${(headlineRatio / style.cta.fontSizeRatio).toFixed(1)}x the size of the CTA label`);
  }
  if (style.trustList.present && style.trustList.fontSizeRatio > 0) {
    comparisons.push(`roughly ${(headlineRatio / style.trustList.fontSizeRatio).toFixed(1)}x the size of the bottom info block's text`);
  }
  if (!comparisons.length) return null;
  return `This headline should read as ${comparisons.join(' and ')} - size these relative to each other precisely, not each in isolation against the canvas alone.`;
}

/** Nearest real /v1/images/edits size enum to the composite's own aspect
 *  ratio - see openai.client.ts's editPosterImage for why this replaced
 *  size:'auto' (a real, live-observed resolution mismatch). Still needed
 *  even without a mask - the endpoint's size behavior is independent of
 *  whether a mask is supplied. */
export function pickEditSize(canvasW: number, canvasH: number): '1024x1024' | '1024x1536' | '1536x1024' {
  const ratio = canvasW / canvasH;
  if (ratio > 1.15) return '1536x1024';
  if (ratio < 0.87) return '1024x1536';
  return '1024x1024';
}

/** Resolves a ColorSpec into the exact instruction fragment - a flat
 *  color statement, or an explicit gradient statement with both real
 *  hex values and a direction. Real defect found live: a flat-color-
 *  only instruction rendered a genuinely gradient-filled reference
 *  headline as flat yellow, because there was nothing to even ask the
 *  model to attempt a gradient with. */
function colorInstruction(spec: ColorSpec): string {
  if (spec.type === 'gradient' && spec.gradientTo) {
    return `a ${spec.gradientDirection ?? 'horizontal'} gradient fill from ${spec.color} to ${spec.gradientTo} - match both colors exactly, do not substitute a similar-looking shade or flatten it to one solid color`;
  }
  return `solid color ${spec.color} - match this color exactly, do not substitute a similar-looking shade`;
}

/** Bookends whatever alignment this specific job's style spec actually
 *  extracted for this element, with a real numeric anchor - not just the
 *  word "center-aligned" restated. Real defect found live, twice: first,
 *  a single mention of "center-aligned" was confirmed silently ignored;
 *  then, restating it MORE emphatically as a pure prose rule ("must be
 *  genuinely CENTER-aligned... do NOT render it flush left") was ALSO
 *  confirmed live to make no difference - pixel-measured, every line of
 *  a real job's centered headline/subtext/info-chip still started at the
 *  identical left edge, the exact signature of left-alignment, despite
 *  that stronger wording being in the prompt. Same root cause as every
 *  other "adjective alone doesn't work" defect this file already
 *  compensates for (font size, color) - the fix is the same one already
 *  proven for those: give the model an actual coordinate to hit instead
 *  of a word. style.centerXRatio is that coordinate - a DIRECT per-job
 *  read of where this design's centered content actually balances,
 *  not derived from the text-column math (marginXRatio +
 *  textColumnWidthRatio/2 was tried first and confirmed live to be
 *  wrong by ~15 percentage points for a reference whose subject sits
 *  BELOW the text rather than beside it - that formula answers "how do
 *  I keep text off a side-by-side subject," a different question).
 *
 *  Deliberately NOT pixel-exact: a real per-job decision was made not
 *  to hammer this into a rigid single-pixel target regardless of how a
 *  given generation actually composes - that would trade "ignores
 *  center" for "forces center even where it fights the photo," a
 *  different failure in the opposite direction. This states center as
 *  the real target with a stated tolerance band, and calls out the one
 *  specific failure signature (every line sharing the same left edge)
 *  that must never happen either way - not a demand for pixel-exact
 *  centering.
 *
 *  This is NOT a hardcoded preference for center OR left - `align` is
 *  decided fresh per job, per element, by analyzeReferenceStyle reading
 *  that job's own reference image; this only makes sure whatever that
 *  per-job decision actually was gets honored instead of silently
 *  reverting to the model's own left-aligned default. */
function alignmentRule(subject: string, align: 'left' | 'center', style: PosterStyleSpec, canvasW: number): string {
  if (align === 'left') {
    return `${subject} should be LEFT-aligned within the text column - every line/row starting near the same left edge, ${pct(style.marginXRatio)} of canvas width (~${pxOfWidth(style.marginXRatio, canvasW)}px) from the left.`;
  }
  const centerRatio = style.centerXRatio;
  const centerPx = pxOfWidth(centerRatio, canvasW);
  return `${subject} should be CENTERED within the text column - aim for each line/row's own horizontal midpoint to land close to ${pct(centerRatio)} of canvas width (~${centerPx}px from the left edge). This doesn't need to be pixel-exact - some natural give either way is fine, whatever reads best with the rest of the design. What must NOT happen: every line sharing the exact same left starting edge as each other regardless of their different lengths - that is left-alignment, not centering, even if it's only a small drift.`;
}

// --- Reference crops: attach real style-reference pictures alongside the prose ---
//
// Confirmed live via a real paid spike call: an image-generation model
// copies a REFERENCE IMAGE's visual structure (layout, color, font, icon
// treatment) far more reliably than any amount of prose can describe it,
// while still honoring an explicit "render only the fresh text specified
// below, not this image's own text" instruction. This closes the gap
// prose alone hit a ceiling on (a multi-part co-branding badge, a
// multi-zone footer both lost real fidelity through description alone,
// no matter how detailed). See VisualReferenceHint's own doc comment on
// openai.client.ts for the full defect history.

/** Deterministic safety cap - cost/latency/confusion-risk grows with
 *  every extra image attached to the same call. OpenAI's real ceiling
 *  for /v1/images/edits is 16 images; this is well under it. Sized for
 *  the realistic ceiling of one real job: 3 mandatory font references
 *  (headline/subtext/CTA, see selectElementsToCrop) plus up to a
 *  handful of genuinely complex structural elements (trustList,
 *  otherElements). */
export const MAX_REFERENCE_CROPS = 6;

export interface CroppableElement {
  name: string; // matches elementOrder's naming convention - "headline" | "subtext" | "cta" | "trustList" | "otherElements[N]"
  label: string; // human-readable - quoted into the prompt AND used as the multipart filename, see editPosterImage
  box: ReferenceBox;
}

/** Gathers the elements to attach as reference crops, in two tiers:
 *
 *  MANDATORY - headline (always), subtext/CTA (if present): font
 *  fidelity always benefits from a real picture, so these are never
 *  gated by AI judgment and never trimmed by the cap. `.recommended`
 *  still gates them technically, but analyzeReferenceStyle's own
 *  instruction tells the model to always set it true for these three -
 *  in practice this just means "was a usable box actually extracted"
 *  (clampVisualReferenceHint forces it back to false on a degenerate
 *  box, so a genuine extraction failure still fails open here rather
 *  than crashing on garbage coordinates).
 *
 *  OPTIONAL - trustList, each otherElements entry: genuinely variable
 *  structural complexity, a real AI judgment call, only fills whatever
 *  budget the mandatory tier leaves behind.
 *
 *  Pure and synchronous - no image I/O - fully unit-testable without
 *  real buffers. This is the single source of truth both the prompt
 *  text and the actual attached images key off of, so the two can never
 *  drift out of sync with each other. */
export function selectElementsToCrop(style: PosterStyleSpec): CroppableElement[] {
  const orderIndex = new Map(style.elementOrder.map((name, i) => [name, i]));
  const byOrder = (a: CroppableElement, b: CroppableElement) =>
    (orderIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER);

  const mandatory: CroppableElement[] = [];
  if (style.headline.visualReference.recommended) {
    mandatory.push({ name: 'headline', label: 'headline style reference', box: style.headline.visualReference.box });
  }
  if (style.subtext.present && style.subtext.visualReference.recommended) {
    mandatory.push({ name: 'subtext', label: 'subtext style reference', box: style.subtext.visualReference.box });
  }
  if (style.cta.present && style.cta.visualReference.recommended) {
    mandatory.push({ name: 'cta', label: 'CTA style reference', box: style.cta.visualReference.box });
  }
  mandatory.sort(byOrder);

  const optional: CroppableElement[] = [];
  if (style.trustList.present && style.trustList.visualReference.recommended) {
    optional.push({ name: 'trustList', label: 'bottom info block style reference', box: style.trustList.visualReference.box });
  }
  style.otherElements.forEach((el, i) => {
    if (el.visualReference.recommended) {
      optional.push({ name: `otherElements[${i}]`, label: `additional element ${i + 1} style reference`, box: el.visualReference.box });
    }
  });
  optional.sort(byOrder);

  const remainingBudget = Math.max(0, MAX_REFERENCE_CROPS - mandatory.length);
  // Final list re-sorted by elementOrder as a whole (not mandatory-then-
  // optional) so "image N" numbering in the prompt still reads as the
  // reference's real top-to-bottom sequence, not an arbitrary tier order.
  return [...mandatory, ...optional.slice(0, remainingBudget)].sort(byOrder);
}

// A style reference doesn't need full resolution to be useful - the
// model only needs to read a font/color/layout from it, not reproduce
// its pixels exactly. Real issue found live: round 6 made font crops
// mandatory (headline/subtext/CTA always attached, on top of any
// AI-recommended structural crops), which made the poster edit call's
// multipart payload meaningfully bigger on every job - capping each
// crop's size directly reduces that added cost without reducing the
// NUMBER of crops (which would undo the actual fidelity fix). JPEG at a
// moderate quality is a further, deliberate size cut on top of the
// resize - fine for a pure style reference, unlike the composite image
// itself (still PNG, still full quality, since that one IS the output).
const MAX_CROP_DIMENSION_PX = 640;
const CROP_JPEG_QUALITY = 82;

/** Deterministic sharp crop against the REAL measured reference image
 *  dimensions - re-clamps the box to the actual bounds rather than
 *  trusting the ratio math alone, same "measure the real thing, don't
 *  trust an assumption" discipline as this file's own canvasW/canvasH
 *  (see runFullContextEdit). Downscales (never upscales) to
 *  MAX_CROP_DIMENSION_PX and re-encodes as JPEG to keep the multipart
 *  payload small regardless of the source reference's own resolution. */
async function cropReferenceElement(referenceBuffer: Buffer, box: ReferenceBox): Promise<Buffer> {
  const { width, height } = await sharp(referenceBuffer).metadata();
  const refW = width ?? 1024;
  const refH = height ?? 1024;
  const left = Math.min(refW - 1, Math.max(0, Math.round(box.xRatio * refW)));
  const top = Math.min(refH - 1, Math.max(0, Math.round(box.yRatio * refH)));
  const w = Math.min(refW - left, Math.max(1, Math.round(box.widthRatio * refW)));
  const h = Math.min(refH - top, Math.max(1, Math.round(box.heightRatio * refH)));
  return sharp(referenceBuffer)
    .extract({ left, top, width: w, height: h })
    .resize(MAX_CROP_DIMENSION_PX, MAX_CROP_DIMENSION_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: CROP_JPEG_QUALITY })
    .toBuffer();
}

// Real gap found live: a tight crop shows an element's exact style in
// isolation but throws away scale context - the model has no direct
// visual way to judge "this badge should be roughly this fraction of
// the whole canvas, this close to the headline," and was left
// reconstructing that from prose ratios alone, which this pipeline has
// already found image models don't always honor precisely. Resized
// (never extracted) - the whole layout, downscaled for scale/position
// judgment only, never for reading fine detail (the tight crops already
// cover that) - slightly larger than an element crop since it needs to
// show the whole design's proportions legibly.
const FULL_REFERENCE_MAX_DIMENSION_PX = 768;

async function prepareFullReferenceImage(referenceBuffer: Buffer): Promise<Buffer> {
  return sharp(referenceBuffer)
    .resize(FULL_REFERENCE_MAX_DIMENSION_PX, FULL_REFERENCE_MAX_DIMENSION_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: CROP_JPEG_QUALITY })
    .toBuffer();
}

/** Same downsize+JPEG treatment as every other attached reference, for
 *  images a USER uploads with an /edit request. Not cosmetic: a raw
 *  15MB upload attached verbatim would bloat the multipart body of a
 *  call that already has a known hang/timeout profile once several
 *  images are attached (see editPosterImage's AbortController note). */
export async function prepareUserReferenceImage(buffer: Buffer): Promise<Buffer> {
  return prepareFullReferenceImage(buffer);
}

/**
 * Precise, numeric layout instructions for the reference's design -
 * same "describe geometry as percentages of canvas, not adjectives"
 * pattern base_asset's own prompt already uses. An image-edit model
 * given adjectives approximates; given the same exact ratios a
 * deterministic renderer would use to compute exact pixel positions, it
 * has a real number to target instead of a vibe.
 *
 * Typography is no longer squeezed into "serif or sans + a weight
 * number" - each headline line (and subtext, and the CTA label) carries
 * its own freeform styleDescription, quoted directly, alongside the
 * numeric size/weight/color. Real defect found live: a reference headline
 * with two visibly different fonts across its two lines rendered both
 * lines in the same font, because the old spec had one shared style for
 * the whole headline - style is now per-line, judged independently.
 *
 * The bottom info block is driven primarily by its own freeform
 * layoutDescription, not forced through a fixed "checkmark bar/card"
 * template - real references vary far more than that (plain bulleted
 * lists with no box, two-zone promo-badge-plus-stat-grid layouts, etc.)
 * and layoutDescription is the authoritative source of truth for that
 * actual structure; the numeric fields are position/size hints layered
 * on top of it, not the structure itself.
 */
function styleInstructionsBlock(style: PosterStyleSpec, canvasW: number, canvasH: number, copy: AdCopy): string {
  const sizeLabel = (ratio: number) => `${pct(ratio)} of canvas width (~${pxOfWidth(ratio, canvasW)}px)`;
  const heightLabel = (ratio: number) => `${pct(ratio)} of canvas height (~${Math.round(ratio * canvasH)}px)`;

  // Built as one chunk of lines per named block, then emitted in
  // style.elementOrder's actual sequence rather than a fixed order -
  // real defect found live: this used to always emit headline -> subtext
  // -> cta -> trustList -> otherElements regardless of the reference's
  // own vertical order, so a reference whose bulleted list sits ABOVE
  // its CTA still rendered the list after the CTA. clampStyle guarantees
  // elementOrder is always a complete, valid list (falls back to this
  // same natural order if the extraction didn't provide one), so every
  // block below is guaranteed to be visited exactly once.
  const blocks: Record<string, string[]> = {};

  const headlineLines: string[] = [
    `Left margin for all text/CTA content: ${pct(style.marginXRatio)} of canvas width from the text column's left edge.`,
    `Headline: ${style.headline.lineCount} line(s), ${style.headline.align}-aligned. Each line has its own distinct style - do NOT render them in the same font unless they're described the same way below:`,
  ];
  style.headline.lines.forEach((line, i) => {
    headlineLines.push(
      `  Line ${i + 1} typography: ${line.styleDescription}. This is the single most important part of this line's styling - render an actual font matching this description, not a generic bold sans-serif default.`
    );
    headlineLines.push(`  Line ${i + 1} size/color: font size ${sizeLabel(line.fontSizeRatio)}, font-weight ${Math.round(line.fontWeight)}, ${colorInstruction(line.color)}.`);
  });
  const relativeSize = relativeSizeSentence(style);
  if (relativeSize) headlineLines.push(relativeSize);
  headlineLines.push(alignmentRule('This headline', style.headline.align, style, canvasW));
  blocks.headline = headlineLines;

  if (style.subtext.present) {
    blocks.subtext = [
      `Subtext typography: ${style.subtext.styleDescription}. Render an actual font matching this description, not a generic default.`,
      `Subtext size/color: font size ${sizeLabel(style.subtext.fontSizeRatio)}, weight ${Math.round(style.subtext.fontWeight)}, ${colorInstruction(style.subtext.color)}, ${style.subtext.align}-aligned. Gap below headline: ${pct(style.spacing.headlineToSubtextGapRatio)} of canvas height.`,
      alignmentRule('This subtext', style.subtext.align, style, canvasW),
    ];
  }

  if (style.cta.present) {
    blocks.cta = [
      `CTA button label typography: ${style.cta.labelStyleDescription}. Render an actual font matching this description, not a generic default.`,
      // Real bug found live: this used to add the "second band showing
      // the price" instruction whenever style.cta.hasPriceBand was true,
      // regardless of whether copy.priceText actually came back with
      // anything - the exact gap that let a fabricated price ("₹1499")
      // appear on a reference that had no price at all. Gated on
      // copy.priceText being genuinely present now, same "never render
      // a slot with nothing real in it" discipline as generateAdCopy's
      // own graceful-omission rule.
      `CTA button: total height ${pct(style.cta.heightRatio)} of canvas height, corner radius ${pct(style.cta.cornerRadiusRatio)} of canvas width, fill color ${style.cta.fillColor} (match exactly, do not substitute a similar-looking shade), label text color ${style.cta.labelTextColor} (match exactly), label weight ${Math.round(style.cta.labelFontWeight)}, label font size ${sizeLabel(style.cta.fontSizeRatio)}, label text ${style.cta.textAlign}-aligned within the button${style.cta.hasPriceBand && copy.priceText ? `, with a second band below the label inside the SAME button (background ${style.cta.priceBandColor}, text color ${style.cta.priceTextColor}, weight ${Math.round(style.cta.priceFontWeight)}) showing the price` : ''}. Gap before this button: ${pct(style.spacing.afterTextBlockGapRatio)} of canvas height.`,
      // CTA alignment is local to the button's own width, not the text
      // column - no real numeric anchor available for it here (button
      // width isn't a stored ratio), so this stays the lighter, word-only
      // reminder rather than borrowing the text-column's midpoint, which
      // would be a wrong number for a button that's narrower than the
      // column.
      style.cta.textAlign === 'center'
        ? "This button's label text should be centered within the button, not pushed flush to one side."
        : "This button's label text should be left-aligned within the button, starting near its left inset, not centered.",
    ];
  }

  const trustListLines: string[] = [];
  if (style.trustList.present) {
    const iconNote = style.trustList.iconStyle === 'none' ? 'no icon or bullet at all' : `a "${style.trustList.iconStyle.replace('-', ' ')}" icon per item (badge color ${style.trustList.checkmarkBadgeColor}, icon color ${style.trustList.checkmarkIconColor})`;
    trustListLines.push(
      `Bottom info block, exactly ${style.trustList.itemCount} item(s): ${style.trustList.layoutDescription} Use ${iconNote}. Reference sizing: background ${style.trustList.backgroundColor} (match exactly), text color ${style.trustList.textColor} (match exactly), weight ${Math.round(style.trustList.fontWeight)}, font size ${sizeLabel(style.trustList.fontSizeRatio)}.`
    );
  }
  if (style.trustList.promoBadge.present) {
    trustListLines.push(`Promo/offer badge, separate from the info block above: ${style.trustList.promoBadge.description}`);
  }
  if (trustListLines.length) blocks.trustList = trustListLines;

  // Catch-all elements - each rendered with a real position/size/gap
  // anchor (previously 100% freeform prose - the two worst-fidelity
  // elements found in a real run, a co-branding badge and an "Invite
  // Only Access" chip, were exactly the two things routed through this
  // field), then each of its parts as its own line in reading order,
  // with generated text quoted verbatim only when that PART actually
  // has text. copy.otherElementTexts is parallel to only the hasText
  // parts across ALL elements, flattened in the same element-then-part
  // order run-deterministic-stage.ts built otherElementPrompts in - a
  // single running counter tracks that, never style.otherElements' own
  // index/part index.
  let otherElementTextIndex = 0;
  style.otherElements.forEach((el, i) => {
    // Real bug found live: consume each hasText part's text FIRST (still
    // exactly once per part, preserving the parallel-array contract with
    // copy.otherElementTexts) so we know, before rendering anything,
    // whether this element ended up with zero genuine content across ALL
    // its parts - e.g. a location+date pill where generateAdCopy
    // correctly, gracefully left both parts empty. Rendering per-part
    // lines in that case would leave a bare icon-only shell (a pin/
    // calendar icon with no labels) with no instruction telling the model
    // to omit it - confirmed live, the model then invents its own content
    // to fill the visual gap (e.g. a city name read off the photo itself).
    const partTexts = el.parts.map((part) => (part.hasText ? copy.otherElementTexts[otherElementTextIndex++] : undefined));
    const hasTextParts = el.parts.some((part) => part.hasText);
    const hasAnyGenuineText = partTexts.some((t) => t);
    if (hasTextParts && !hasAnyGenuineText) {
      blocks[`otherElements[${i}]`] = [
        `Additional element ${i + 1} (${el.description}): OMIT THIS ENTIRE ELEMENT - no genuine content was available for this campaign, do not render it, its icons, or any placeholder text for it.`,
      ];
      return;
    }
    const lines: string[] = [
      `Additional element ${i + 1}: ${el.description} Position: ${el.positionDescription}. Vertical center ~${heightLabel(el.approxYRatio)} from the top, height ~${heightLabel(el.approxHeightRatio)}, gap above it: ${heightLabel(el.gapAboveRatio)}.`,
    ];
    el.parts.forEach((part, j) => {
      const text = partTexts[j];
      const textInstruction = text
        ? ` Render this exact text on it, verbatim: "${text}"`
        : part.hasText
          ? ' No genuine text was available for this part - do NOT render it at all (no placeholder text, no invented content) - omit this part entirely.'
          : ' This part is icon/glyph only, no text.';
      lines.push(`  Part ${j + 1}${el.parts.length > 1 ? ` of ${el.parts.length}, in this left-to-right order` : ''}: ${colorInstruction(part.color)}. Typographic/icon character: ${part.styleDescription}.${textInstruction}`);
    });
    lines.push(alignmentRule(`Additional element ${i + 1}'s content (icon+text together, as a whole)`, el.align, style, canvasW));
    blocks[`otherElements[${i}]`] = lines;
  });

  // Real bug found live: textColumnWidthRatio was extracted every time
  // and never once read anywhere in this file - the one number that
  // exists specifically to keep text off the photo's subject was
  // computed and silently dropped. Stated here as a genuine hard
  // boundary, same "a real number, not a vibe" pattern
  // detectLogoPosition's own topAreaMaxY constraint already uses
  // successfully for the logo. Bookended - repeated in the closing "Do
  // NOT" list below, same proven technique base_asset's own no-text
  // rule already uses (a single mention was confirmed live to lose
  // against competing instructions).
  const boundary = textColumnBoundary(style, canvasW);
  const textBoundaryLine = `HARD BOUNDARY: all text and design elements (headline, subtext, CTA, trust list) must stay entirely within the left ${boundary.pctLabel} of canvas width (~${boundary.px}px from the left edge, measured against this exact canvas). Do not let any letter, word, or element extend past this line, even if it means a smaller font or an extra line - the photo's subject occupies the space to the right of this boundary and must never be touched, crowded, or covered.`;

  // Rendered first, behind every other element below - this is a
  // background-layer TEXTURE, not a discrete line of copy someone reads
  // (unlike every other text block above, it has no single position; it
  // repeats/tiles across a region). Real defect this fixes: this design
  // device previously had nowhere to go in the extracted style at all
  // (excluded from base_asset's non-text-only backgroundTreatment,
  // didn't fit otherElements' single-position chip model) and was
  // silently dropped, so a reference's single most distinctive visual
  // signature never reached the generated poster.
  const backgroundPatternLines: string[] = [];
  if (style.backgroundPattern.present && style.backgroundPattern.word) {
    backgroundPatternLines.push(
      `Background pattern (render this FIRST, as a background layer behind the photo's subject and behind every other text element below - it is decorative texture, not copy meant to be individually read): the word "${style.backgroundPattern.word}" repeated/tiled across the composition.${style.backgroundPattern.containerDescription ? ` Container: ${style.backgroundPattern.containerDescription}.` : ''} Typographic treatment: ${style.backgroundPattern.styleDescription}. ${colorInstruction(style.backgroundPattern.color)}, rendered at roughly ${pct(style.backgroundPattern.opacityRatio)} opacity (most of these read as faded or outline-only, not solid). Do not let this repeated word read as a legible headline or CTA - it is background texture only, and must never cover or reduce the legibility of the actual headline/subtext/CTA/trust-list text.
  IMPORTANT, a real defect found live: the color panel this texture belongs on may already exist in the photo you were given, but an earlier generation step is unreliable at repeating the same word legibly and may have left it blank, or left a garbled/malformed attempt there instead (drifting letterforms, duplicated or dropped letters, inconsistent shapes between repeats). Do not preserve a broken attempt just because "something is already there" - if the existing panel has no lettering, or has malformed/illegible lettering, paint over that area completely with a single, cleanly and consistently repeated instance of the real word above. Every repeat of the word must use the exact same letterforms as every other repeat - do not let it drift or vary from one repetition to the next.`
    );
  }

  return [textBoundaryLine, ...backgroundPatternLines, ...style.elementOrder.flatMap((name) => blocks[name] ?? [])].join('\n');
}

export interface FullContextEditParams {
  campaignBrief: string;
  compositionGuide: string;
  backgroundTreatment: string;
  photoStyle: BaseLayerSpec['photoStyle'];
  logoBox: ExclusionBox | null;
  copy: AdCopy;
  style: PosterStyleSpec;
  canvasW: number; // for concrete-pixel size statements alongside percentages - see styleInstructionsBlock
  canvasH: number; // otherElements' approxYRatio/approxHeightRatio/gapAboveRatio are all height fractions, same as spacing.* - needs the real height, not just width
  // The elements actually being attached as real reference-image crops
  // this call (selectElementsToCrop's output) - only used to number/
  // label them correctly in the prompt text; the actual cropped bytes
  // are attached separately via editPosterImage's referenceImages. Empty
  // when no element was recommended for a crop - today's exact
  // text-only behavior.
  referenceCrops: CroppableElement[];
  // Whether the whole (downscaled) reference image is ALSO attached,
  // after all referenceCrops, purely for scale/position judgment - see
  // prepareFullReferenceImage's own doc comment. Only used here to
  // number/label it correctly in the prompt text; the actual bytes are
  // attached separately via editPosterImage's referenceImages, same
  // split as referenceCrops.
  includeFullReferenceImage: boolean;
  /** How many images the USER attached to an /edit request. Attached
   *  last, after referenceCrops and the full reference - only used here
   *  to number and label them in the manifest; the bytes are passed
   *  separately, same split as the two fields above. 0 for every
   *  pipeline-driven render. */
  userReferenceCount?: number;
  feedback?: string;
}

/**
 * The complete instruction for the single full-context edit call that
 * replaces the old masked, region-restricted approach. There is no mask
 * anymore - the model sees the whole photo+logo image and is trusted
 * with a richly detailed, structured description of exactly what must
 * stay the same and exactly what to add, rather than a hard pixel
 * boundary enforcing it. This is a deliberate trade, made explicitly:
 * the old mask gave a technical guarantee the photo/logo couldn't be
 * touched; this gives up that guarantee in exchange for one simpler,
 * more directly-controllable generation step, and leans on this
 * prompt's specificity plus the downstream QA gate
 * (buildVerificationRubric below) to catch a violation instead of
 * making one structurally impossible.
 */
export function buildFullContextEditPrompt(params: FullContextEditParams): string {
  const { copy, style } = params;
  const lines: string[] = [];

  // Explicit, numbered role for EVERY attached image, stated once as a
  // manifest up front - real defect found live: earlier versions gave
  // reference images an explicit number and role ("Image 2 is...",
  // "Image 3 is...") but never gave Image 1 (the actual edit target)
  // that same explicit, numbered treatment - it was only ever "a
  // finished, real photograph," referred to generically. On a real job
  // whose reference happened to depict similar subject matter to the
  // actual photo (both showed runners in front of a city landmark), the
  // model blended real details FROM the reference INTO Image 1's output
  // (a runner's shirt pattern changed, the landmark's rendering style
  // drifted toward the reference's own) despite a single "do not copy
  // this image's photo" caveat sitting next to the reference alone. The
  // fix is symmetry: every image - including Image 1 - gets the same
  // numbered, role-labeled treatment up front, and "never blend content
  // across images just because two of them happen to look similar" is
  // its own explicit, standalone rule rather than something only implied
  // by what wasn't said about Image 1.
  const manifestLines = [
    // The logo half is conditional: with no logo this used to assert
    // "it already has a brand logo correctly placed on it", which is a
    // false statement to an image model about the image it is editing -
    // the likely result being that it helpfully invents one. Saying
    // nothing is safer than either lying or naming the thing we don't
    // want (this model has previously produced exactly what a prompt
    // told it not to).
    params.logoBox
      ? '- Image 1: THE PHOTO YOU ARE EDITING. The only image whose content should end up in your output. It already has a brand logo correctly placed on it. Everything you generate is built directly on top of THIS exact photo, unchanged except for the new text/design elements described below.'
      : '- Image 1: THE PHOTO YOU ARE EDITING. The only image whose content should end up in your output. Everything you generate is built directly on top of THIS exact photo, unchanged except for the new text/design elements described below.',
  ];
  params.referenceCrops.forEach((crop, i) => {
    manifestLines.push(
      `- Image ${i + 2}: a real photo crop from a DIFFERENT, unrelated reference design, showing exactly how the reference's ${crop.label} should look. Style reference ONLY - never a source of content, pixels, or subject matter for your output.`
    );
  });
  if (params.includeFullReferenceImage) {
    const fullRefImageNumber = params.referenceCrops.length + 2;
    manifestLines.push(
      `- Image ${fullRefImageNumber}: the FULL layout of that same different, unrelated reference design, shown only so you can judge scale and position - not the photo to edit, not a source of subject matter.`
    );
  }
  // User attachments come last, matching runFullContextEdit's own
  // ordering when it appends them to referenceImages.
  const userRefCount = params.userReferenceCount ?? 0;
  if (userRefCount > 0) {
    const firstUserImageNumber = params.referenceCrops.length + (params.includeFullReferenceImage ? 1 : 0) + 2;
    for (let i = 0; i < userRefCount; i++) {
      manifestLines.push(
        `- Image ${firstUserImageNumber + i}: a reference image the USER attached with their change request${
          userRefCount > 1 ? ` (${i + 1} of ${userRefCount})` : ''
        }, showing the look they are asking for. Use it for style, color, treatment or proportion as their request describes - never as a source of subject matter or pixels for your output, and never blended into Image 1's own photograph.`
      );
    }
  }
  lines.push('Images attached to this request, in order, and what each one is for:');
  lines.push(manifestLines.join('\n'));
  lines.push(
    "\nCRITICAL, stated once here because it overrides everything else if ignored: if Image 1 and any reference image above happen to show similar subject matter (e.g. both show people, a building, a landmark, a similar scene) - that is coincidence, not permission to blend them. Every pixel of Image 1's own photo (its subject, their clothing, their pose, the background, any landmark, the lighting) must survive into your output completely untouched, no matter how similar OR different a reference image looks. A reference image's job is font, color, layout, and proportion ONLY - it must never influence what Image 1's own photographic content looks like."
  );

  lines.push("\nWhat already exists in Image 1 and must NOT change in any way:");
  lines.push(`- The photograph itself: ${params.compositionGuide}`);
  if (params.backgroundTreatment) {
    lines.push(`- A background design treatment already baked into the photo: ${params.backgroundTreatment}`);
  }
  lines.push(
    `- Style already established: ${params.photoStyle.colorGrading}; ${params.photoStyle.lighting}; ${params.photoStyle.setting}; ${params.photoStyle.framing}.`
  );
  if (params.logoBox) {
    lines.push(
      `- The brand logo, already correctly placed at pixel position (${params.logoBox.x}, ${params.logoBox.y}), size ${params.logoBox.width}x${params.logoBox.height}. Do not cover, move, resize, recolor, or otherwise alter it in any way.`
    );
  }

  // Behavioral instructions for the reference crops/full image - WHAT
  // they're for was already stated in the manifest above; this is HOW to
  // use them (confirmed live via a real paid spike call that an
  // image-generation model copies a picture's structure/color/font/icon-
  // treatment far more reliably than prose alone, while still honoring
  // an explicit "render only the fresh text specified below, not this
  // image's own text" instruction).
  if (params.referenceCrops.length) {
    lines.push(
      "\nTreat each attached reference crop (Image 2 onward, per the manifest above) as a TEMPLATE to fill in, not inspiration for a new design - reproduce its exact visual structure, proportions, spacing, colors, icon usage (or deliberate absence of icons), and font character as closely as physically possible. The ONLY thing that should differ from the crop is the actual text content, which must be exactly what is specified below - do not creatively reinterpret, simplify, embellish, or restyle the crop's design."
    );
    lines.push(
      "CRITICAL: Do NOT copy any literal text, numbers, or words visible in these reference images - they belong to a completely different, unrelated design. Render ONLY the text specified above and below, exactly as quoted."
    );
  }

  lines.push('\nCampaign context (for tone only - do not render any of this as text unless it is explicitly quoted below):');
  lines.push(params.campaignBrief);

  lines.push('\nRender this exact text, verbatim, no paraphrasing, no adding or dropping words or characters:');
  lines.push(
    `- Headline (render as exactly ${copy.headlineLines.length} separate line(s), in this order - do NOT run them together into one sentence): ${copy.headlineLines.map((l, i) => `Line ${i + 1}: "${l}"`).join('; ')}`
  );
  if (copy.subtext) lines.push(`- Subtext: "${copy.subtext}"`);
  if (copy.ctaLabel) {
    lines.push(`- CTA button label: "${copy.ctaLabel}"${copy.priceText ? ` with price text "${copy.priceText}" on the same button` : ''}`);
  } else if (copy.priceText) {
    lines.push(`- Price/offer text: "${copy.priceText}"`);
  }
  if (copy.trustItems.length) lines.push(`- Trust points: ${copy.trustItems.map((t) => `"${t}"`).join(', ')}`);
  if (style.trustList.promoBadge.present && copy.promoBadgeText) lines.push(`- Promo/offer badge label: "${copy.promoBadgeText}"`);
  // Bookended - also quoted in context within styleInstructionsBlock's
  // per-otherElements block below, same "state it twice, don't rely on
  // one mention" discipline as every other copy field here. Real gap
  // this closes: otherElementTexts was previously ONLY ever quoted
  // in-context, never in this top-level list, and buildVerificationRubric
  // now checks against this same list - see that function's own comment.
  if (copy.otherElementTexts.length) lines.push(`- Additional element labels: ${copy.otherElementTexts.map((t) => `"${t}"`).join(', ')}`);

  // Systematic absence enforcement: every optional element gets an
  // EXPLICIT negative instruction when the style spec says it isn't
  // present, never just silence. Real defect found live: a reference
  // with no standalone CTA button at all (the bottom bar itself was the
  // call-to-action) still got a "REGISTER NOW" button added, because
  // nothing forbade one - the image model's own prior ("ads have
  // buttons") won against silence. Same "state it as a hard rule, don't
  // rely on omission" principle base_asset's own negative constraints
  // already use.
  const absenceRules: string[] = [];
  if (!style.subtext.present) absenceRules.push('- Do NOT add a subtext/supporting line beneath the headline - none exists in this design.');
  if (!style.cta.present) absenceRules.push('- Do NOT add a standalone CTA button or pill of any kind - this design has no separate button, do not invent one even though many ads have one.');
  if (!style.trustList.present) absenceRules.push('- Do NOT add a bottom trust/info list or bar of any kind - none exists in this design.');
  if (style.trustList.present && style.trustList.iconStyle === 'none') {
    absenceRules.push('- Do NOT add checkmark icons, bullet dots, or any icon before the info-block items - none are used in this design, the items are plain text.');
  }
  if (!style.trustList.promoBadge.present) absenceRules.push('- Do NOT add a separate promo/offer badge (e.g. a percent-off icon or a "SALE" pill) - none exists in this design.');
  if (style.cta.present && !style.cta.hasPriceBand) absenceRules.push("- Do NOT add a second price/offer band inside or below the CTA button - this design's CTA has no price band.");
  // Same rule, second reason: hasPriceBand was true but no genuine price
  // was generated (see generateAdCopy's graceful-omission rule) - do not
  // let the model invent one just because the slot exists structurally.
  if (style.cta.present && style.cta.hasPriceBand && !copy.priceText) {
    absenceRules.push('- Do NOT add a second price/offer band inside or below the CTA button - no real price or offer information was available for this campaign.');
  }
  if (style.trustList.present && !style.trustList.priceRow.present) absenceRules.push('- Do NOT add a highlighted price/offer row inside the bottom info block - none exists in this design.');
  if (absenceRules.length) {
    lines.push('\nElements this design does NOT have - do not add ANY of these, even though a typical ad might include one:');
    lines.push(absenceRules.join('\n'));
  }

  lines.push('\nExact layout to follow for the new elements above:');
  lines.push(styleInstructionsBlock(style, params.canvasW, params.canvasH, copy));

  lines.push('\nDo NOT do any of the following, under any circumstances:');
  lines.push(
    `- Do NOT alter the photograph${params.logoBox ? ' or the logo' : ''} in any way - not ${params.logoBox ? 'their' : 'its'} color, position, size, or any other detail - and do NOT add any new physical object, prop, or accessory onto the subject or scene that wasn't already there (e.g. a race bib, a sign, a piece of clothing or jewelry) - even if the campaign brief or an attached reference image mentions or shows one; the photo is already final and must not gain new objects.`
  );
  lines.push(
    "- Do NOT let Image 1's own subject, clothing, pose, background, or landmark drift toward how a reference image (Image 2 onward) renders similar subject matter, even slightly - if they happen to look alike, that is a coincidence, not a cue to blend them. Image 1's photo content is the ONLY photo content allowed in your output."
  );
  {
    const boundary = textColumnBoundary(style, params.canvasW);
    lines.push(`- Do NOT let any text or design element extend past the left ${boundary.pctLabel} of canvas width (~${boundary.px}px) - the photo's subject sits beyond this line and must never be touched, crowded, or covered.`);
  }
  lines.push('- Do NOT paraphrase, add, drop, or reorder any word or character in the quoted copy strings above.');
  lines.push('- Do NOT use a hyphen or dash (-, –, —) anywhere, even if it would appear in the quoted copy strings above.');
  lines.push('- Do NOT let any text or icon overflow the canvas or get cut off at its edge.');
  lines.push(
    '- Do NOT add any decorative element, divider, separator (e.g. vertical bars "|", dots, lines), border, icon, or design flourish that is not explicitly listed above. Render EXACTLY the elements listed - nothing more.'
  );
  // Real bug found live: this used to unconditionally tell the model to
  // add a shadow to every job's text, regardless of whether the
  // reference actually had one - a genuinely hardcoded default this
  // pipeline is otherwise built to avoid. Flipped: flat by default,
  // shadow/glow only when a specific element's own typographic
  // description (from analyzeReferenceStyle, see styleInstructionsBlock's
  // per-element typography lines above) explicitly says so.
  lines.push(
    "Do NOT add any shadow, glow, or outline treatment to any text UNLESS that specific element's own typographic description above explicitly mentions one - render flat and clean by default, matching the reference's own actual treatment exactly. Never paint a new background panel behind text either way."
  );

  if (params.feedback) lines.push(`\nPrevious attempt feedback - fix this specifically: ${params.feedback}`);

  return lines.join('\n');
}

// --- Verification ---
//
// One vision call, same "generator and judge are different models"
// principle as everywhere else in this pipeline. Checks both exact text
// correctness AND that the photo/logo weren't altered - a mask used to
// make the latter structurally impossible to get wrong; without one,
// this check is the only thing standing in for that guarantee, so it
// checks for it explicitly rather than assuming it.

/**
 * The same set of hard requirements this rubric has always checked,
 * reorganized under 7 named, independently-judged fields instead of one
 * flat bullet list - see verifyPoster()'s own doc comment for why. The
 * substance of each check is unchanged; only the grouping is new.
 */
export function buildVerificationRubric(
  copy: AdCopy,
  style: PosterStyleSpec,
  /** Whether this job actually has a brand logo on the canvas.
   *
   *  Defaults to true so every existing caller keeps its exact previous
   *  behaviour - this is an addition, not a signature break. When false,
   *  field 5 checks the photograph alone: a judge told to verify a logo
   *  that was never placed will fail a perfectly correct poster for the
   *  absence of something nobody asked for. */
  hasLogo = true
): string {
  const lines: string[] = [];
  lines.push(
    `Verify this ad poster image against the 7 numbered checks below. Verify BOTH the exact text content and that the underlying photo${hasLogo ? ' and logo' : ''} ${hasLogo ? 'were' : 'was'} not altered from what ${hasLogo ? 'they' : 'it'} should already be. These are 7 separate, independent checks - judge each one strictly on its own merits; a failure on one must never lower your judgment of a different one.`
  );
  lines.push(
    'Word-for-word means every WORD must be present, unchanged, and in order. It does NOT mean punctuation has to match exactly - a missing/extra trailing period, comma, or other punctuation mark alone is NOT a failure and must NOT be scored down. It also does NOT mean capitalization has to match exactly - a word rendered in ALL CAPS or Title Case when the target string below uses different casing is the SAME word and is NOT a failure on its own; judge word identity by content, not by casing, exactly like punctuation. Only fail on missing words, added words, changed words, or misspellings.'
  );
  lines.push(
    "The campaign's actual reference image is attached below - use it as a visual anchor for overall style/fidelity (does this poster genuinely read like the same kind of design as the reference), on top of the exact-text checks that follow."
  );

  lines.push(
    `\n1. "headline" - fails if it does not read, word-for-word, as: "${copy.headlineLines.join(' ')}" (rendered across ${copy.headlineLines.length} line(s) is fine, but every word must be present, unchanged, in order).`
  );

  lines.push(
    copy.subtext
      ? `\n2. "subtext" - fails if it does not read, word-for-word, as: "${copy.subtext}"`
      : '\n2. "subtext" - this design has no subtext. Pass automatically UNLESS one incorrectly appears.'
  );

  {
    const ctaChecks: string[] = [];
    if (copy.ctaLabel) ctaChecks.push(`does not read, word-for-word, as: "${copy.ctaLabel}"`);
    if (copy.priceText && style.cta.hasPriceBand) ctaChecks.push(`its price band does not read, word-for-word, as: "${copy.priceText}"`);
    if (!style.cta.present) {
      lines.push('\n3. "cta" - this design has no CTA button. Pass automatically UNLESS one incorrectly appears.');
    } else {
      lines.push(`\n3. "cta" - fails if the CTA button ${ctaChecks.length ? ctaChecks.join(', or if ') : 'is missing or unreadable'}.`);
    }
  }

  // Real gap found live: this used to check every other generated copy
  // field word-for-word but never otherElementTexts (a badge's "Presented
  // by X" label) - there was no rule that could catch it being wrong,
  // garbled, or hallucinated, however badly, so a bad render passed QA.
  // Trust points, additional element labels, and the promo badge are
  // bundled into one field here (rather than three) since they're all
  // the same kind of "miscellaneous campaign-specific label" check.
  {
    const otherChecks: string[] = [];
    if (copy.trustItems.length) otherChecks.push(`the trust points do not match, word-for-word: ${copy.trustItems.map((t) => `"${t}"`).join(', ')}`);
    if (copy.otherElementTexts.length) otherChecks.push(`the additional element labels do not match, word-for-word: ${copy.otherElementTexts.map((t) => `"${t}"`).join(', ')}`);
    if (style.trustList.promoBadge.present && copy.promoBadgeText) otherChecks.push(`the promo badge label does not read, word-for-word, as: "${copy.promoBadgeText}"`);
    if (!style.cta.present && style.trustList.priceRow.present && copy.priceText) {
      otherChecks.push(`the trust list's highlighted price row does not read, word-for-word, as: "${copy.priceText}"`);
    }
    // No fixed parenthetical naming every sub-category here on purpose -
    // real bug caught by this file's own tests: an earlier draft always
    // wrote "(trust points, additional element labels, promo badge)" in
    // this field's header regardless of which actually apply, so a
    // design with zero otherElementTexts still had that literal phrase
    // sitting in the rubric. Only the checks that genuinely apply are
    // named, exactly like every other field above.
    lines.push(
      otherChecks.length
        ? `\n4. "otherElements" - fails if ${otherChecks.join(', or if ')}.`
        : '\n4. "otherElements" - this design has no trust points, additional elements, or promo badge. Pass automatically UNLESS one incorrectly appears.'
    );
  }

  lines.push(
    // The field KEEPS its "photoAndLogo" name even with no logo: it is a
    // stable key in the 7-field verdict object that verifyPoster parses
    // and openai.client.ts's VerificationFields type declares. Renaming
    // it per-job would make the response shape vary by input.
    hasLogo
      ? "\n5. \"photoAndLogo\" - fails if the photo itself looks different from before this edit (a different scene, subject, lighting, or color treatment than what was already established, including any new physical object, prop, or accessory appearing on or near the subject that was not part of the original photo - e.g. a race bib, a new clothing item, jewelry, a sign), OR if the brand logo is covered, moved, resized, recolored, or otherwise altered from how it was already correctly placed."
      : "\n5. \"photoAndLogo\" - fails if the photo itself looks different from before this edit (a different scene, subject, lighting, or color treatment than what was already established, including any new physical object, prop, or accessory appearing on or near the subject that was not part of the original photo - e.g. a race bib, a new clothing item, jewelry, a sign)."
  );

  // Symmetric with buildFullContextEditPrompt's absence rules - a
  // missing requested element already fails via the word-for-word
  // checks above; this is the other half, catching an ADDED element the
  // style spec said should NOT exist (e.g. a CTA button hallucinated
  // onto a design that has none), so the QA gate can actually catch a
  // repeat of that defect instead of relying on the prompt alone.
  {
    const decorationChecks: string[] = [
      'any decorative element not part of the listed text/CTA/checkmarks appears - dividers, vertical bars, dots, borders, or flourishes that were not explicitly requested',
    ];
    if (!style.cta.present) decorationChecks.push('a CTA button or pill of any kind appears, even though this design has none');
    if (!style.trustList.present) decorationChecks.push('a bottom trust/info list or bar appears, even though this design has none');
    if (style.trustList.present && style.trustList.iconStyle === 'none') {
      decorationChecks.push('checkmark icons or bullet dots appear before the info-block items, even though this design uses plain text with no icon');
    }
    if (!style.trustList.promoBadge.present) decorationChecks.push('a separate promo/offer badge (percent icon, "SALE" pill, or similar) appears, even though this design has none');
    if (style.cta.present && !style.cta.hasPriceBand) decorationChecks.push("a second price/offer band appears inside or below the CTA button, even though this design's CTA has none");
    if (style.cta.present && style.cta.hasPriceBand && !copy.priceText) {
      decorationChecks.push('a second price/offer band (with any price or offer text, real or invented) appears inside or below the CTA button, even though no genuine price was specified for this campaign');
    }
    if (style.trustList.present && !style.trustList.priceRow.present) decorationChecks.push('a highlighted price/offer row appears inside the bottom info block, even though this design has none');
    lines.push(`\n6. "noExtraDecoration" - fails if ${decorationChecks.join(', or if ')}.`);
  }

  // Real bug found live: the original zero-tolerance wording ("even if
  // the text is otherwise legible") forced a retry on a minor, mostly-
  // fine arm graze that should have passed - softened to distinguish
  // genuine coverage (a face, hands, a meaningful portion of the body)
  // from incidental contact, which is explicitly NOT a failure on its
  // own.
  lines.push(
    "\n7. \"legibility\" - fails if any text or icon overlaps another element or is cut off/extends past the image edge, OR if any text/icon SUBSTANTIALLY overlaps or covers the photo's own subject (a face, hands, or a meaningful portion of the body - a minor, incidental graze, e.g. a letter's edge lightly touching an arm or background element, is NOT a failure on its own), OR if any text is illegible or unreasonably small relative to the poster."
  );

  // Real, confirmed-live gap this closes: none of the 7 checks above ever
  // verified alignment at all - a real job's headline/subtext rendered
  // with inconsistent, neither-left-nor-center positioning (line centers
  // spread across a 66px range) and still scored well, because nothing
  // was checking it. Built per-job from the SAME align values the
  // generation prompt was given (poster-text-edit.ts's alignmentRule) -
  // this is not a fixed preference for either direction, it is checking
  // whatever this specific job's own design actually calls for.
  {
    const alignmentChecks: string[] = [
      `the headline is not genuinely ${style.headline.align.toUpperCase()}-aligned (${style.headline.align === 'center' ? "its lines should share a common horizontal center, with each line's own midpoint lining up - NOT all sharing the same left edge" : 'every line should start at the same left edge - NOT have their centers lined up instead'})`,
    ];
    if (style.subtext.present) {
      alignmentChecks.push(
        `the subtext is not genuinely ${style.subtext.align.toUpperCase()}-aligned (same test as the headline: ${style.subtext.align === 'center' ? 'its own horizontal center should line up with the rest of the centered content' : 'it should start at the same left edge as the rest of the left-aligned content'})`
      );
    }
    style.otherElements.forEach((el, i) => {
      alignmentChecks.push(`additional element ${i + 1}'s content is not genuinely ${el.align.toUpperCase()}-aligned within the text column`);
    });
    lines.push(
      `\n8. "alignment" - fails if ${alignmentChecks.join(', or if ')}. Judge this by comparing multiple lines/rows against EACH OTHER, not any single one in isolation: if every line starts at the exact same left x position regardless of how long each line is, that is LEFT alignment (a hard fail wherever CENTER was required above); if each line's own horizontal midpoint lines up instead - a shorter line visibly indented relative to a longer one - that is CENTER alignment (a hard fail wherever LEFT was required above). Inconsistent positioning that is clearly neither is also a fail.`
    );
  }

  lines.push(
    "\nFor any field with no hard failure, judge it normally (7-10 equivalent) on overall legibility, visual balance, professional appearance, how naturally the text blends with the photo's own lighting and color, and how closely the rendered text sizing and coloring matches the specified targets (undersized, oversized, or off-color text should count against that field even if legible)."
  );

  return lines.join('\n');
}

export interface FullContextEditResult {
  imageBuffer: Buffer;
  instruction: string;
  canvasW: number;
  canvasH: number;
  latencyMs: number;
  costInr: number;
}

/**
 * Orchestrates one full-context edit attempt: builds the instruction and
 * calls the real editPosterImage() provider function with no mask,
 * defensively resizing back to the input's exact canvas if the endpoint
 * returned a different resolution (the same real, live-observed
 * mismatch this pipeline already guards against for the masked case -
 * unrelated to whether a mask is supplied). Does not touch Cloudinary or
 * QA - the caller (run-deterministic-stage.ts) owns upload + scoring.
 */
export async function runFullContextEdit(
  compositeBuffer: Buffer,
  referenceImageBuffer: Buffer | null,
  params: Omit<FullContextEditParams, 'canvasW' | 'canvasH' | 'referenceCrops' | 'includeFullReferenceImage'>,
  /** Extra images a USER attached to an /edit request, appended after
   *  this call's own derived crops. Already downsized by the caller via
   *  prepareUserReferenceImage. Each gets an explicit labelled role, the
   *  same discipline every other attachment here follows - an unlabelled
   *  image has been silently ignored by a model before. */
  userReferenceImages: Array<{ buffer: Buffer; label: string }> = []
): Promise<FullContextEditResult> {
  const { width, height } = await sharp(compositeBuffer).metadata();
  const canvasW = width ?? 1024;
  const canvasH = height ?? 1024;

  // Fails open, never a new failure mode: no reference buffer available,
  // nothing recommended, or an unexpected crop error -> zero crops,
  // today's exact text-only behavior. This is strictly additive on top
  // of an already-working pipeline.
  let referenceImages: Array<{ buffer: Buffer; label: string }> = [];
  let selectedCrops: CroppableElement[] = [];
  let includeFullReferenceImage = false;
  if (referenceImageBuffer) {
    try {
      selectedCrops = selectElementsToCrop(params.style);
      referenceImages = await Promise.all(
        selectedCrops.map(async (c) => ({ buffer: await cropReferenceElement(referenceImageBuffer, c.box), label: c.label }))
      );
      // Only when at least one element crop is already being sent - if
      // nothing is complex enough to warrant a crop, there's no
      // scale-context question to answer either, so this stays a
      // genuinely conditional addition, not an always-on cost.
      if (selectedCrops.length > 0) {
        referenceImages.push({ buffer: await prepareFullReferenceImage(referenceImageBuffer), label: 'full reference layout (scale and position context)' });
        includeFullReferenceImage = true;
      }
    } catch {
      selectedCrops = [];
      referenceImages = [];
      includeFullReferenceImage = false;
    }
  }

  // canvasW/canvasH are always the real, just-measured composite
  // dimensions - never supplied by the caller, since they aren't known
  // until this buffer is actually read.
  const instruction = buildFullContextEditPrompt({
    ...params,
    canvasW,
    canvasH,
    referenceCrops: selectedCrops,
    includeFullReferenceImage,
    userReferenceCount: userReferenceImages.length,
  });
  const size = pickEditSize(canvasW, canvasH);

  // User attachments go LAST, after the derived crops and the full
  // reference - the prompt's image manifest numbers them in exactly this
  // order, so the order here and there must not drift.
  const edit = await editPosterImage({
    imageBuffer: compositeBuffer,
    instruction,
    size,
    referenceImages: [...referenceImages, ...userReferenceImages],
  });

  const outputMeta = await sharp(edit.imageBuffer).metadata();
  const resizedOutput =
    outputMeta.width === canvasW && outputMeta.height === canvasH
      ? edit.imageBuffer
      : await sharp(edit.imageBuffer).resize(canvasW, canvasH, { fit: 'fill' }).png().toBuffer();

  return {
    imageBuffer: resizedOutput,
    instruction,
    canvasW,
    canvasH,
    latencyMs: edit.latencyMs,
    costInr: edit.costInr,
  };
}
