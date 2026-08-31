import { createHttpClient } from '../lib/http-client';
import { requireEnv } from '../lib/env';

const openai = createHttpClient('https://api.openai.com/v1');

export interface ScoreImageParams {
  imageUrl: string;
  rubricPrompt: string; // the specific checklist for this stage, e.g. LLD's composition/realism rubric
  /** Real gap found live: every scoreImage call used to judge the
   *  candidate image completely blind - no campaign reference image, no
   *  extracted style context, nothing to compare against. That's why a
   *  genuinely good base_asset (e.g. an authentic photo of a real
   *  monument with its own carved inscriptions, or a reference-matching
   *  stylized/duotone treatment) could get rejected against a generic,
   *  one-size-fits-all bar. Optional - existing callers that don't pass
   *  this are unaffected. */
  referenceImages?: VisionImageInput[];
}

export interface ScoreImageResult {
  qaScore: number; // 0–10
  qaReasoning: string;
  latencyMs: number;
  costInr: number;
}

export interface DetectLogoPositionParams {
  imageUrl: string; // the real base_asset image - placement is decided by looking at what actually got generated, not a pre-decided zone
  canvasWidth: number;
  canvasHeight: number;
  logoWidth: number; // already computed deterministically (aspect-preserved) - the model is not asked to size it
  logoHeight: number;
  marginXHint: number; // a reasonable side-margin-from-edge suggestion in px, deterministic - the model can still judge the exact number
  topAreaMaxY: number; // hard constraint: the logo's top edge must not exceed this y, in px
  feedback?: string; // present on a retry after a failed post-placement QA
}

export interface DetectLogoPositionResult {
  x: number;
  y: number;
  latencyMs: number;
  costInr: number;
}

const VISION_COST_INR_PER_CALL = 0.44; // ~$0.005 at time of writing, NFR §4 QA-call estimate
const TEXT_COST_INR_PER_CALL = 0.15; // no image tokens, meaningfully cheaper than a vision call

/** One labeled image for a multi-image vision call. Labeled the same
 *  way gemini.client.ts's ReferenceImage.role is - a bare, unlabeled
 *  image is exactly what let a reference get silently ignored by a
 *  model before (see that file's comment); classifyBaseLayer is the
 *  first caller here that ever sends more than one image, so the
 *  label discipline has to exist from the start, not be bolted on
 *  after the same failure mode shows up again. */
export interface VisionImageInput {
  url: string;
  label: string;
}

/**
 * `temperature` is optional and, when omitted, the request body simply
 * doesn't include it (the API's own default applies) - every existing
 * call site's behavior is unchanged. Real defect found live: the SAME
 * reference image, re-extracted fresh on two different job submissions
 * (analyzeReferenceStyle is deliberately never cached - see
 * render-poster.ts), came back with meaningfully different structural
 * reads - a gradient headline one time, a flat color the next; a plain
 * bullet list one time, a boxed checkmark card the next. Vision
 * "observe and describe what's actually there" calls want run-to-run
 * consistency far more than the API's default sampling temperature
 * provides - callers doing that kind of observation (not creative
 * copywriting) pass a low value explicitly.
 */
async function callChatModel(instructionPrompt: string, images?: VisionImageInput[], temperature?: number) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  // No hardcoded fallback model string: an unset OPENAI_VISION_MODEL is a
  // startup-config bug, not something that should silently default to
  // whatever model happened to be hardcoded here at write time. Reused
  // for text-only calls too (ad copy generation) - it's a general chat
  // model, not a vision-only one, and this repo only configures the one.
  const model = process.env.OPENAI_VISION_MODEL;
  if (!model) throw new Error('OPENAI_VISION_MODEL is not configured');

  const content = images?.length
    ? [
        { type: 'text', text: instructionPrompt },
        ...images.flatMap((img) => [
          { type: 'text', text: `Image - ${img.label}` },
          { type: 'image_url', image_url: { url: img.url } },
        ]),
      ]
    : instructionPrompt;

  const startedAt = Date.now();
  const response = await openai.post(
    '/chat/completions',
    {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      ...(temperature !== undefined ? { temperature } : {}),
    },
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  const latencyMs = Date.now() - startedAt;
  const responseContent = response.data.choices[0].message.content as string;
  return { parsed: JSON.parse(responseContent), latencyMs };
}

async function callVisionModel(imageUrl: string, instructionPrompt: string, temperature?: number) {
  return callChatModel(instructionPrompt, [{ url: imageUrl, label: 'reference' }], temperature);
}

export async function scoreImage(params: ScoreImageParams): Promise<ScoreImageResult> {
  // Real, confirmed-live bug: with qaScore requested BEFORE qaReasoning,
  // the model commits to a number before it has actually worked through
  // the checklist - the reasoning keeps going afterward and sometimes
  // reverses the verdict entirely (a real job's own qaReasoning ended
  // "Correction: This image should NOT fail!... the correct score
  // should be 9" while the qaScore field it had already written stayed
  // at 2, escalating a poster that was actually fine). Reordering so
  // qaReasoning comes first forces the score to be a product of the
  // completed reasoning, not a guess made before it - same principle as
  // asking a person to show their work before stating the final answer.
  const instruction = `${params.rubricPrompt}\n\nRespond ONLY with JSON, in this exact field order - work through your full reasoning in "qaReasoning" FIRST, then let "qaScore" be your conclusion FROM that reasoning, not a number decided before it: {"qaReasoning": string, "qaScore": number (0-10)}.`;
  // callVisionModel labels its one image the generic 'reference', which
  // is fine when there's only ever one image but actively misleading now
  // that a real campaign reference image can also be attached - call
  // callChatModel directly so both images get an unambiguous label.
  const images: VisionImageInput[] = [
    { url: params.imageUrl, label: 'the newly generated image you are scoring' },
    ...(params.referenceImages ?? []),
  ];
  const { parsed, latencyMs } = await callChatModel(instruction, images);

  return {
    qaScore: Number(parsed.qaScore),
    qaReasoning: String(parsed.qaReasoning),
    latencyMs,
    costInr: VISION_COST_INR_PER_CALL,
  };
}

/** One independently-judged field's verdict - reasoning first, pass
 *  second, same "show your work before the answer" principle as
 *  scoreImage's own qaReasoning/qaScore ordering, just applied at the
 *  per-field level too. */
export interface PosterVerificationField {
  reasoning: string;
  pass: boolean;
}

/** The 7 fields buildVerificationRubric (poster-text-edit.ts) organizes
 *  its checks under. A field that doesn't apply to a given design (e.g.
 *  "cta" with no CTA button) still comes back with pass: true and a
 *  "not applicable" reasoning - see verifyPoster's instruction. */
export interface PosterVerificationFields {
  headline: PosterVerificationField;
  subtext: PosterVerificationField;
  cta: PosterVerificationField;
  otherElements: PosterVerificationField;
  photoAndLogo: PosterVerificationField;
  noExtraDecoration: PosterVerificationField;
  legibility: PosterVerificationField;
  /** Real, confirmed-live gap this closes: none of the 7 checks above
   *  ever verified that an element actually rendered with the alignment
   *  its own style spec called for - a real job's headline/subtext came
   *  out with inconsistent, neither-left-nor-center positioning (line
   *  centers spread across a 66px range) and still scored well, because
   *  nothing was checking alignment at all. This field asks the exact
   *  question: does each element's rendered alignment (lines sharing a
   *  left edge vs. lines sharing a horizontal center) match what was
   *  asked for, per-element, per-job - not a fixed preference for either
   *  direction. */
  alignment: PosterVerificationField;
}

export interface VerifyPosterParams {
  imageUrl: string;
  rubricPrompt: string; // buildVerificationRubric's output - already organized under the 7 fields above
  referenceImages?: VisionImageInput[];
}

export interface VerifyPosterResult {
  fields: PosterVerificationFields;
  qaReasoning: string; // overall summary, built from overallReasoning - kept for StageAttempt.qaReasoning/dashboard display
  qaScore: number; // 0–10, kept for handle-stage-result.ts's generic PASS/RETRY/ESCALATE threshold
  latencyMs: number;
  costInr: number;
}

/**
 * Real, confirmed-live defect this replaces: scoreImage()'s flat
 * {qaScore, qaReasoning} shape gives the rest of the system nothing to
 * act on except "pass or fail, and a paragraph explaining why" - so a
 * retry could only ever throw away ALL the copy and forward the ENTIRE
 * old paragraph as "feedback." On a real job, that paragraph literally
 * quoted the old (correct) headline as confirmed-passing text; the new
 * attempt's fresh copy had a genuinely different headline; the edit
 * model saw both and rendered the OLD one, since nothing distinguished
 * "this already passed, don't touch it" from "here's what to fix."
 *
 * verifyPoster() asks for the same checks buildVerificationRubric
 * already describes, but returns pass/fail PER FIELD instead of one
 * blob - so a caller (run-deterministic-stage.ts's runPosterStage) can
 * pin the copy fields that already passed to their exact previous
 * values on a retry, regenerate only the ones that didn't, and build a
 * short, targeted feedback string instead of forwarding the whole prior
 * verdict. Generation itself is untouched - still one holistic edit
 * call, no masks, no per-layer generation seams; only verification and
 * retry-targeting become granular.
 */
export async function verifyPoster(params: VerifyPosterParams): Promise<VerifyPosterResult> {
  const instruction = `${params.rubricPrompt}\n\nRespond ONLY with JSON, in this exact field order - for EACH of the 8 fields, write its "reasoning" FIRST and let "pass" be your conclusion FROM that reasoning, then write "overallReasoning" and "qaScore" LAST, as your conclusion from all 8 fields above, not a number decided before them:
{"fields": {"headline": {"reasoning": string, "pass": boolean}, "subtext": {"reasoning": string, "pass": boolean}, "cta": {"reasoning": string, "pass": boolean}, "otherElements": {"reasoning": string, "pass": boolean}, "photoAndLogo": {"reasoning": string, "pass": boolean}, "noExtraDecoration": {"reasoning": string, "pass": boolean}, "legibility": {"reasoning": string, "pass": boolean}, "alignment": {"reasoning": string, "pass": boolean}}, "overallReasoning": string, "qaScore": number (0-10)}
For any field explicitly marked "this design has none" / "pass automatically" in the checks above, still write a brief reasoning (e.g. "not applicable - this design has no CTA") and set pass: true, UNLESS that field's own hard-fail condition (something appearing when it shouldn't) is actually triggered.`;

  const images: VisionImageInput[] = [
    { url: params.imageUrl, label: 'the newly generated image you are scoring' },
    ...(params.referenceImages ?? []),
  ];
  const { parsed, latencyMs } = await callChatModel(instruction, images);

  const rawFields = parsed.fields ?? {};
  const toField = (raw: unknown): PosterVerificationField => {
    const r = raw as Partial<PosterVerificationField> | undefined;
    return { reasoning: String(r?.reasoning ?? ''), pass: !!r?.pass };
  };
  const fields: PosterVerificationFields = {
    headline: toField(rawFields.headline),
    subtext: toField(rawFields.subtext),
    cta: toField(rawFields.cta),
    otherElements: toField(rawFields.otherElements),
    photoAndLogo: toField(rawFields.photoAndLogo),
    noExtraDecoration: toField(rawFields.noExtraDecoration),
    legibility: toField(rawFields.legibility),
    alignment: toField(rawFields.alignment),
  };

  return {
    fields,
    qaReasoning: String(parsed.overallReasoning ?? ''),
    qaScore: Number(parsed.qaScore),
    latencyMs,
    costInr: VISION_COST_INR_PER_CALL,
  };
}

/**
 * Replaces the old 3-bucket left/center/right decision (with a separate
 * pixel-clutter override correcting it after the fact). This pipeline no
 * longer pre-computes candidate boxes for the model to choose between -
 * instead every piece of deterministic context (canvas size, the logo's
 * own already-sized dimensions, a margin suggestion, the top-area
 * constraint) is handed to the model ALONGSIDE the real generated photo,
 * and it is asked for one exact coordinate. This works because the model
 * now has the same information a human placing the logo by eye would
 * have, rather than being asked to guess a bucket from a text
 * description alone. The 100% real geometry constraint - the logo can
 * never render outside the canvas or below the top-area line - is still
 * validated deterministically by the calling stage (never trusted blind),
 * same "never trust an AI number without checking it" discipline as
 * everywhere else in this pipeline; the difference is what's being
 * checked (in-bounds) rather than what's being decided (which bucket).
 */
export async function detectLogoPosition(params: DetectLogoPositionParams): Promise<DetectLogoPositionResult> {
  const instruction = `Look at this real photo and decide the exact top-left pixel coordinate to place a brand logo, so it looks natural, intentional, and doesn't cover anything important (faces, hands, key objects, or busy detail).

Canvas size: ${params.canvasWidth}x${params.canvasHeight} px.
The logo will be placed at exactly ${params.logoWidth}x${params.logoHeight} px - it is already sized correctly, do not suggest a different size.
Hard constraint: the logo's top edge (y) must be between 0 and ${params.topAreaMaxY} px - it must stay in the top area of the frame.
Horizontally it can go anywhere that looks right - flush left, flush right, centered, or anywhere in between - based on which exact spot in THIS photo is genuinely cleanest. Do not default to a fixed side out of habit; judge this photo specifically. x must be between 0 and ${params.canvasWidth - params.logoWidth} px.
A reasonable side margin from the canvas edge, if you place it near an edge, is around ${params.marginXHint} px as a starting reference - use your own judgment on what actually looks right for this specific photo, not a rigid rule.
${params.feedback ? `Previous placement was tried and didn't work - fix this specifically: ${params.feedback}` : ''}

Respond ONLY with JSON: {"x": number, "y": number}.`;

  const { parsed, latencyMs } = await callVisionModel(params.imageUrl, instruction);

  return {
    x: Number(parsed.x),
    y: Number(parsed.y),
    latencyMs,
    costInr: VISION_COST_INR_PER_CALL,
  };
}

export interface GenerateAdCopyParams {
  brief: string;
  /** From analyzeReferenceStyle() - the reference's own structure has a
   *  specific number of headline lines and trust points, and the copy
   *  should match that structure rather than the model picking its own
   *  counts independently. Confirmed necessary live: two real reference
   *  layouts had a 2-line and a 4-line headline respectively, and a
   *  fixed "1-2 lines" instruction can't represent both. */
  headlineLineCount: number;
  hasSubtext: boolean;
  hasCtaButton: boolean;
  trustItemCount: number;
  hasPriceLine: boolean;
  /** From analyzeReferenceStyle()'s trustList.promoBadge.present - a
   *  separate promo/offer badge (e.g. "EARLY BIRD SALE") needs its own
   *  short label text generated, same as every other copy field, never
   *  hardcoded. */
  hasPromoBadge: boolean;
  /** From analyzeReferenceStyle()'s otherElements - one entry per
   *  otherElements item with hasText: true, its own description, so the
   *  copy call knows what each slot is for. Never the reference's own
   *  text - see otherElements' own doc comment on why copying a real
   *  partner name across campaigns would be actively wrong. */
  otherElementPrompts: string[];
}

export interface AdCopy {
  headlineLines: string[];
  subtext?: string;
  ctaLabel?: string;
  priceText?: string; // used as either the CTA's price band or the trust-list's price row, whichever the reference has
  trustItems: string[];
  promoBadgeText?: string; // short label for trustList.promoBadge, e.g. "EARLY BIRD SALE"
  /** Parallel array to GenerateAdCopyParams.otherElementPrompts - one
   *  short generic label per prompt, same index. */
  otherElementTexts: string[];
}

export interface GenerateAdCopyResult extends AdCopy {
  latencyMs: number;
  costInr: number;
}

/**
 * Text-only (no image) - replaces what used to be Gemini re-drawing the
 * whole poster just to add text. This call only decides WHAT the copy
 * says; layout/rendering is deterministic (render-poster.ts), the same
 * split base_asset -> logo_detection -> logo_composite already uses for
 * "AI decides content/placement, code executes it exactly." Character
 * counts here are loose hints, not guarantees - render-poster.ts's
 * fitText() is the real backstop that keeps whatever comes back on
 * canvas, confirmed necessary live (this model doesn't reliably stay
 * under a stated character limit).
 */
// Any hyphen/en-dash/em-dash, deterministically stripped from every
// generated copy field below regardless of whether the model honored
// the instruction not to use one - real generated output has used an
// em-dash mid-headline before ("...lasting relief—at your desk.") even
// with no instruction against it. Never trust an instruction alone for
// something checkable in code, same principle as every clamp/cap
// elsewhere in this pipeline.
// A dash strictly at an ALLOWED edge (start/end, per the caller) is just
// removed.
//
// Every other dash is replaced with either ", " or " ", chosen by
// whether real whitespace already surrounded it in the source text -
// real bug found live: a single fixed ", " replacement handled the
// motivating case fine ("X - Y" / "X—Y", a genuine two-clause
// separator, reads correctly as "X, Y") but silently broke a HYPHENATED
// COMPOUND WORD, which has no whitespace around its hyphen at all
// ("mom-to-be", "doctor-approved") - blindly inserting a comma there
// produced grammatically broken output ("mom, to, be", "Doctor,
// approved plans"), confirmed on a real paid run. A tight, no-
// whitespace dash is replaced with a plain space instead - this reads
// correctly for a genuine compound word ("mom to be", "doctor approved")
// AND still reads fine for the original tight-em-dash motivating case
// ("relief at your desk"), so one rule covers both without needing to
// actually distinguish "is this really a compound word" - something
// this function has no reliable way to know.
function stripDashesCore(text: string, allowLeadingStrip: boolean, allowTrailingStrip: boolean): string {
  return text
    .replace(/\s*[-‐-―]\s*/g, (match, offset: number, full: string) => {
      const atStart = offset === 0;
      const atEnd = offset + match.length >= full.length;
      if (atStart && allowLeadingStrip) return '';
      if (atEnd && allowTrailingStrip) return '';
      const hadSurroundingWhitespace = match.length > 1; // more than just the bare dash character itself
      return hadSurroundingWhitespace ? ', ' : ' ';
    })
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

export function stripDashes(text: string): string {
  return stripDashesCore(text, true, true);
}

/**
 * Real bug found live: applying stripDashes() independently to each
 * element of headlineLines treated a dash sitting at a natural
 * line-break point (e.g. line 1 ends "...Pain -", line 2 starts "Feel
 * Relief...") as a STRING edge for that one line, deleting it outright
 * instead of converting it to a comma - producing the ungrammatical
 * "Say Goodbye to Pain Feel Relief in Minutes" (missing conjunction),
 * caught by the poster's own visual QA rubric on a real paid run. Only
 * the true first line's leading edge and the true last line's trailing
 * edge are real edges of the overall headline; every other line
 * boundary is mid-sentence and must get a comma, same as any other
 * mid-string dash.
 */
export function stripDashesFromLines(lines: string[]): string[] {
  return lines.map((line, i) => stripDashesCore(line, i === 0, i === lines.length - 1));
}

function stripDashesFromCopy(copy: AdCopy): AdCopy {
  return {
    headlineLines: stripDashesFromLines(copy.headlineLines),
    subtext: copy.subtext ? stripDashes(copy.subtext) : copy.subtext,
    ctaLabel: copy.ctaLabel ? stripDashes(copy.ctaLabel) : copy.ctaLabel,
    priceText: copy.priceText ? stripDashes(copy.priceText) : copy.priceText,
    trustItems: copy.trustItems.map(stripDashes),
    promoBadgeText: copy.promoBadgeText ? stripDashes(copy.promoBadgeText) : copy.promoBadgeText,
    otherElementTexts: copy.otherElementTexts.map(stripDashes),
  };
}

export async function generateAdCopy(params: GenerateAdCopyParams): Promise<GenerateAdCopyResult> {
  const instruction = `You are writing ad copy for a health/wellness campaign poster, for an Indian audience by default (Indian context, tone, and currency in ₹) unless the campaign brief below clearly specifies a different market. Campaign brief:
${params.brief}

Write concise ad copy for a 1:1 square poster. If the brief specifies exact wording, use it verbatim. Otherwise compose short, punchy, on-brief copy yourself. Match this exact structure (matching a layout reference the design has already been built around):
- Headline: exactly ${params.headlineLineCount} short line(s), each around 12-20 characters, split however reads best across that many lines.
${params.hasSubtext ? '- Subtext: one short supporting line, around 35-45 characters.' : '- No subtext needed.'}
${params.hasCtaButton ? '- CTA button label: short imperative, e.g. "JOIN TODAY".' : '- No CTA button needed.'}
${params.hasPriceLine ? '- A short price/offer line, e.g. "From ₹299/month".' : '- No price line needed.'}
${params.trustItemCount > 0 ? `- Exactly ${params.trustItemCount} short trust points, each around 12-20 characters.` : '- No trust points needed.'}
${params.hasPromoBadge ? '- A short promo/offer badge label, e.g. "EARLY BIRD SALE" or "LIMITED SEATS", around 10-18 characters.' : "- No promo badge label needed here - promoBadgeText is ONLY for a badge attached to/inside the trust list block. If the additional-elements list below describes something that sounds like a promo bar or offer badge, that is a SEPARATE, standalone element - write its content in otherElementTexts at its own index instead, never here."}
${
  params.otherElementPrompts.length > 0
    ? `- Additional small elements - each array index below corresponds to ONE part of a design element (an element with multiple sibling parts, marked as such below, together forms one combined badge - e.g. a location+date pill made of a city part and a date part): ${params.otherElementPrompts.map((p, i) => `[${i}] for: "${p}"`).join('; ')}. For each part, either write genuine short campaign-appropriate content (around 8-20 characters, NOT copied from any real brand/partner name OR its initials/monogram, e.g. a co-branding slot becomes something like "In Partnership With") if you actually have specific content for THAT exact part, or leave it as an empty string if you don't. Do NOT feel obligated to fill every part just because the array has a slot for it, and do NOT put content into a later sibling part just to avoid leaving it blank when an earlier sibling part already covered that same information - it is completely normal and expected for a sibling part to stay empty. Write otherElementTexts as an array with exactly ${params.otherElementPrompts.length} entries in that same order.`
    : '- No additional small elements needed.'
}

Never use a hyphen or dash (-, –, —) anywhere in any field - rephrase with a comma, "and", or a separate short clause instead.

CRITICAL, a real defect found live: for ANY field above where the campaign brief doesn't give you enough to write genuine, specific, campaign-appropriate content (a real date, a real location, a real price) - do NOT invent a plausible-sounding fake value (e.g. a made-up price like "₹1499" with no basis in the brief), and do NOT write a description of what the field is instead of actual content (e.g. never write literal placeholder-sounding phrases like "Event date" or "Race location" or "Event date information" as if they were the real content). Instead return null for that field (or an empty string for the matching entry in otherElementTexts) - it will be omitted from the design entirely, which is always preferable to fabricated or meta content.
The real test to apply, since this mistake keeps reappearing in new phrasings (e.g. "Event location and date" is the exact same violation as "Event date" above, just worded differently): if the text you're about to write is a generic description of what KIND of information belongs in that slot - it reads like a label FOR the field rather than the field's actual content, e.g. it names "date", "location", "time", "venue", or similar as a description rather than stating a genuine value - that is the same violation no matter how it's phrased. Return null instead.

Respond ONLY with JSON: {"headlineLines": string[], "subtext": string | null, "ctaLabel": string | null, "priceText": string | null, "trustItems": string[], "promoBadgeText": string | null, "otherElementTexts": string[]}.`;

  const { parsed, latencyMs } = await callChatModel(instruction);

  const copy = stripDashesFromCopy({
    headlineLines: parsed.headlineLines,
    subtext: parsed.subtext ?? undefined,
    ctaLabel: parsed.ctaLabel ?? undefined,
    priceText: parsed.priceText ?? undefined,
    trustItems: parsed.trustItems ?? [],
    // Real bug found live: the model sometimes writes real content here
    // even when told it isn't needed - render-poster.ts's
    // buildFullContextEditPrompt only ever emits promoBadgeText when
    // style.trustList.promoBadge.present is true, so a value here while
    // hasPromoBadge is false is always orphaned, never rendered, and
    // only confuses debugging (the content usually belonged in
    // otherElementTexts instead - this doesn't recover it, just stops
    // storing dead data).
    promoBadgeText: params.hasPromoBadge ? (parsed.promoBadgeText ?? undefined) : undefined,
    otherElementTexts: parsed.otherElementTexts ?? [],
  });

  return {
    ...copy,
    latencyMs,
    costInr: TEXT_COST_INR_PER_CALL,
  };
}

/** Shared by every place a text/fill color can appear - captures a
 *  gradient fill (e.g. a gold-to-white headline), not just a flat hex.
 *  Real defect found live: a flat-color-only field rendered a genuinely
 *  gradient-filled reference headline as flat yellow - there was no way
 *  to even ask the model whether a gradient was present. */
export interface ColorSpec {
  type: 'solid' | 'gradient';
  color: string; // hex - the solid color, or the gradient's start color
  gradientTo?: string; // hex - only meaningful when type === 'gradient'
  gradientDirection?: 'horizontal' | 'vertical' | 'diagonal';
}

/** A bounding box in the REFERENCE image's OWN pixel space, as ratios of
 *  ITS width/height - explicitly a DIFFERENT coordinate space from every
 *  other ratio in PosterStyleSpec, which are all judged against the
 *  CURRENT composite's canvas (deliberately - the two images can be
 *  different sizes, see analyzeReferenceStyle's own doc comment). Only
 *  ever used to crop the real reference image (poster-text-edit.ts's
 *  cropReferenceElement) - never used to size or position anything on
 *  the output canvas. */
export interface ReferenceBox {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

/** Per-element judgment: is this element's visual treatment simple
 *  enough to fully capture in the ratio/hex/prose fields already on it
 *  (a flat solid button, a plain sans-serif line), or complex enough (a
 *  distinctive font, a multi-zone layout, several visual parts, an icon
 *  treatment) that attaching an actual picture of it to the final
 *  generation call would help significantly more? Never a hardcoded
 *  include/exclude list by element TYPE in code - the same vision call
 *  already looking at and describing this element makes this judgment
 *  fresh, per job. Real defect this targets: a multi-part co-branding
 *  badge and a multi-zone footer both kept losing structural fidelity
 *  (wrong colors, wrong font, invented icons) through prose alone, no
 *  matter how detailed the description got - "match style, not
 *  content" instruction + an attached crop, confirmed live in a real
 *  paid spike call, transfers structure far more reliably than words
 *  alone.
 *
 *  `box` is always returned (never omitted, same "never omit a key"
 *  discipline as everywhere else in this spec) but is only meaningful
 *  when `recommended` is true - see render-poster.ts's
 *  clampVisualReferenceHint, which forces recommended to false if the
 *  box can't actually back a real crop. */
export interface VisualReferenceHint {
  recommended: boolean;
  box: ReferenceBox;
}

/** One headline LINE's own style, judged independently - never assumed
 *  uniform across the whole headline. Real defect found live: a
 *  reference with a lighter lead-in line ("Hyderabad, Let's") followed
 *  by a completely different bold condensed punchline ("RUN AS ONE")
 *  rendered both lines in the same font, because the old spec only had
 *  one shared style for the entire headline. */
export interface HeadlineLineStyle {
  fontSizeRatio: number; // font-size as a fraction of canvas WIDTH
  fontWeight: number; // 400-900 - still a real, useful rendering target alongside styleDescription
  // Freeform, in-depth description of this line's actual typographic
  // character - condensed/wide, italic/upright, script/geometric/
  // display, letter-spacing feel, serif/sans woven in as part of the
  // description rather than a 2-value enum - everything a fixed enum +
  // a weight number can't say. Specific enough to steer a real
  // generation toward the same FEEL, not just size/weight. Same
  // "describe it specifically, don't classify into a bucket" principle
  // as base_layer_classification's compositionGuide.
  styleDescription: string;
  color: ColorSpec;
}

export interface PosterStyleSpec {
  marginXRatio: number; // left margin as a fraction of canvas width - shared by headline/subtext/CTA/trust-card
  spacing: {
    logoToHeadlineGapRatio: number; // fraction of canvas HEIGHT
    headlineToSubtextGapRatio: number;
    afterTextBlockGapRatio: number; // gap after subtext (or headline if no subtext) before the CTA/trust list
    ctaToTrustListGapRatio: number; // only matters if both a CTA and a trust list are present
  };
  headline: {
    lineCount: number;
    align: 'left' | 'center';
    // One style entry per line, in order - see HeadlineLineStyle's doc
    // comment for why this replaced one shared style for the whole
    // headline.
    lines: HeadlineLineStyle[];
    // Covers the whole headline block (all lines together) - see
    // VisualReferenceHint's own doc comment. Not per-line: a single crop
    // of the whole headline area naturally shows every line's font at
    // once, cheaper than N separate slivers.
    visualReference: VisualReferenceHint;
  };
  subtext: {
    present: boolean;
    fontSizeRatio: number;
    fontWeight: number;
    styleDescription: string; // same freeform typographic-feel field as headline lines
    color: ColorSpec;
    align: 'left' | 'center';
    visualReference: VisualReferenceHint;
  };
  cta: {
    present: boolean; // e.g. a standalone pill/rect button - some references have no separate CTA at all
    heightRatio: number; // total button height (both bands if two-part) as a fraction of canvas HEIGHT
    cornerRadiusRatio: number; // as a fraction of canvas width
    fillColor: string;
    labelTextColor: string;
    labelFontWeight: number;
    labelStyleDescription: string; // freeform typographic-feel field for the button label specifically
    hasPriceBand: boolean; // a second band below the label, inside the SAME button
    priceBandColor: string;
    priceTextColor: string;
    priceFontWeight: number;
    fontSizeRatio: number;
    textAlign: 'left' | 'center';
    textInsetRatio: number; // horizontal text padding inside the button, as a fraction of canvas WIDTH
    visualReference: VisualReferenceHint;
  };
  /**
   * The bottom info block - deliberately NOT assumed to be "a trust
   * list with checkmarks." Real references vary wildly here: a plain
   * bulleted list directly on the photo with no box and no checkmark; a
   * two-zone bar (a colored promo badge next to a stat grid where each
   * item stacks a big number over a small label, no checkmarks at all);
   * the traditional checkmark bar/card this was originally modeled on.
   * `layoutDescription` is the authoritative source of truth for the
   * ACTUAL structure - the other fields are layout hints, not a
   * template this block is forced into.
   */
  trustList: {
    present: boolean;
    itemCount: number;
    // Authoritative, in-depth structural description of what this block
    // actually looks like - e.g. "a two-zone bar: left ~25% is a solid
    // navy block with a white circular percent-badge icon and bold
    // italic label; right ~75% has 4 equal columns separated by thin
    // dot dividers, each showing a large bold number stacked above a
    // smaller regular-weight descriptor" or "a simple vertical list of
    // short bulleted phrases in italic white text, plain round bullet
    // dots, no background box, directly on the photo." Quoted into the
    // final prompt near-verbatim.
    layoutDescription: string;
    iconStyle: 'checkmark-filled' | 'checkmark-outline' | 'flat-checkmark' | 'bullet-dot' | 'none' | 'custom';
    presentation: 'bar' | 'card' | 'inline' | 'none'; // 'inline' = a plain list with no box/background at all - new, for the plain-bullet case
    heightRatio: number; // 'bar': bar height as a fraction of canvas HEIGHT. 'card'/'inline': ignored, height follows content.
    cardWidthRatio: number; // 'card' only: card width as a fraction of canvas WIDTH
    cardCornerRadiusRatio: number; // 'card' only: as a fraction of canvas width, 0 if sharp corners
    backgroundColor: string; // bar fill, or card fill - ignored for 'inline'
    dividerColor: string; // 'card' only: thin line color between rows - same as backgroundColor if no visible dividers
    textColor: string;
    fontWeight: number;
    fontSizeRatio: number;
    checkmarkBadgeColor: string; // ignored when iconStyle is 'bullet-dot', 'none', or 'custom'
    checkmarkIconColor: string;
    checkmarkSizeRatio: number; // badge radius (or icon/dot size) as a fraction of canvas WIDTH
    iconTextGapRatio: number; // gap between the icon/bullet and its text, fraction of canvas WIDTH
    iconOffsetRatio: number; // 'bar' only: left offset of the icon within each item's column, fraction of canvas WIDTH
    rowHeightRatio: number; // 'card'/'inline' only: height of each row, fraction of canvas HEIGHT
    priceRowHeightRatio: number; // 'card' only, if priceRow.present
    cardPaddingXRatio: number; // 'card' only: horizontal inner padding, fraction of canvas WIDTH
    priceRow: {
      present: boolean; // a highlighted row at the bottom of a 'card' list showing a price/offer - distinct from cta.hasPriceBand
      backgroundColor: string;
      textColor: string;
      fontWeight: number;
    };
    // A separate promotional/offer badge sitting alongside this block -
    // e.g. a colored pill with a percent icon and "EARLY BIRD SALE."
    // Distinct from priceRow (which lives INSIDE a card list) and from
    // cta (a standalone button) - this is its own small visual element.
    // Its own short label TEXT is generated by generateAdCopy, never
    // hardcoded here - description covers only its visual container.
    promoBadge: {
      present: boolean;
      description: string;
    };
    visualReference: VisualReferenceHint;
  };
  textColumnWidthRatio: number; // how much of canvas WIDTH the text column occupies
  /**
   * Real, confirmed-live defect this fixes: centered elements used to be
   * anchored on marginXRatio + textColumnWidthRatio/2 - a number built
   * for a DIFFERENT purpose (the HARD BOUNDARY keeping text off a
   * side-by-side photo subject) and only coincidentally close to a
   * design's real visual center for a side-by-side layout. For a
   * reference where the subject sits BELOW the text instead (text spans
   * the FULL canvas width, dead center), that formula computed ~35% of
   * canvas width while the reference's own text actually centers at
   * ~50% - a real, measured 15-point error the edit model then followed
   * faithfully to a visibly wrong result. This is a direct, independent
   * read of the actual answer - not derived from unrelated numbers -
   * so it is correct regardless of whether the composition is
   * side-by-side, subject-below, full-bleed, or anything else.
   */
  centerXRatio: number; // where centered content's own horizontal midpoint actually sits, as a ratio of canvas WIDTH - only meaningful for elements whose align is 'center'
  /**
   * A large-scale word or short phrase repeated/tiled purely as a
   * background TEXTURE - not a piece of copy meant to be individually
   * read, but a decorative device (e.g. a giant outlined brand word
   * repeated diagonally behind the subject). Real defect found live:
   * this is unambiguously "text" per the letters-count-as-text rule
   * classifyBaseLayer uses for backgroundTreatment, so it can never be
   * captured there (base_asset's non-text-only field) - but it also
   * never fit otherElements' model, which assumes one discrete chip at
   * one precise position (approxYRatio/approxHeightRatio), not a
   * texture that repeats across a whole region. With nowhere to go, it
   * was silently dropped entirely - the reference's single most
   * visually distinctive design device never reached the generated
   * poster at all. null if the reference doesn't use this device.
   */
  backgroundPattern: {
    present: boolean;
    word: string; // the literal repeated word/phrase, read directly off the reference - never invented
    containerDescription: string; // the shape/color/extent of the region this texture sits within, e.g. "a solid diagonal color-block panel, golden yellow, covering the upper-right ~45% of the canvas along a diagonal line from upper-left to lower-right" - empty string if the texture has no distinct container (sits directly on the photo)
    styleDescription: string; // the word's own typographic treatment - outlined/hollow vs filled, weight, letter-spacing, roughly how large and how densely each repeat reads relative to canvas height
    color: ColorSpec;
    opacityRatio: number; // 0-1, how faded/subtle vs solid the repeated text reads - most of these are low-opacity or outline-only, not solid
  };
  /**
   * Catch-all for any distinct design element that doesn't fit headline/
   * subtext/cta/trustList - e.g. a secondary co-branding badge under the
   * logo, a ribbon, a seal, a small tag. A sibling of trustList (not
   * nested inside it) because it can appear anywhere in the composition.
   * Exists because any finite named schema will always miss some
   * element type a real reference uses - same escape-hatch principle as
   * layoutDescription, but for whole elements rather than one block's
   * internal structure. Empty array if nothing else is present.
   *
   * Unlike every other element in this spec, this used to be pure prose
   * (one description string + one hasText flag) - the only element with
   * no numeric anchor at all. Real defect found live: a reference's
   * "Presented by ET / The Economic Times" co-branding badge - three
   * visually distinct sub-parts (a plain label, a colored icon-box, a
   * serif wordmark), each its own font/color, in a specific left-to-
   * right order - rendered as one flattened, wrongly-ordered, wrongly-
   * colored, single-font blob, because there was no vocabulary to
   * express "this element has parts" or "give it a real position." Now
   * gets the same ratio-based anchor + per-part styling every other
   * element already has.
   */
  otherElements: Array<{
    description: string; // the element's overall CONTAINER only - shape, border, background fill; not per-part text/font/color, see parts below
    positionDescription: string; // concrete, e.g. "directly below the logo, left-aligned to the text column" - never vague ("somewhere near the top")
    /** Real defect found live: this element's horizontal placement used
     *  to rely ENTIRELY on the freeform positionDescription prose above
     *  ("...centered to the text column") with no real field backing it
     *  - unlike headline/subtext/cta, which each get their own explicit
     *  align enum. A real job's location/date chip and offer bar both
     *  extracted as "centered" in positionDescription but rendered
     *  flush-left anyway - the same weak-single-mention problem this
     *  field now gets the same treatment for as every other alignment
     *  field (see poster-text-edit.ts's alignmentRule, which reinforces
     *  whichever value is extracted here as a bookended hard rule). */
    align: 'left' | 'center';
    approxYRatio: number; // this element's vertical CENTER as a fraction of canvas height - the numeric anchor that was missing entirely before
    approxHeightRatio: number; // this element's total height as a fraction of canvas height
    gapAboveRatio: number; // gap from whatever sits directly above it (logo, headline, etc), fraction of canvas height - same convention as spacing.*
    /** Ordered left-to-right (or top-to-bottom, whichever the element
     *  actually reads as) sub-parts within this one element - e.g.
     *  ["PRESENTED BY" plain sans label, "ET" red icon-box glyph, "The
     *  Economic Times" serif wordmark]. Same "judge each independently,
     *  never assume uniformity" principle as headline.lines. A simple
     *  single-font element still gets exactly one entry here. */
    parts: Array<{
      text: string | null; // literal reference text for a pure icon/glyph part with nothing to say about wording - null, never guessed
      hasText: boolean; // whether THIS part needs fresh generated copy - see generateAdCopy's otherElementPrompts, now flattened per-part
      styleDescription: string; // this part's own typographic/icon character, independent of every other part - same principle as HeadlineLineStyle
      color: ColorSpec;
    }>;
    visualReference: VisualReferenceHint;
  }>;
  /**
   * The reference's REAL top-to-bottom (or logical) reading order of its
   * top-level blocks, as an ordered list of element names drawn from:
   * "headline", "subtext", "cta", "trustList", and "otherElements[N]"
   * (N = that entry's index in the otherElements array above, e.g.
   * "otherElements[0]"). Real defect found live: this pipeline always
   * rendered headline -> subtext -> cta -> trustList -> otherElements in
   * that fixed order regardless of the reference, so a reference whose
   * bulleted trust list actually sits ABOVE its CTA came out with the
   * list rendered after the CTA instead. Only include elements that are
   * actually present (skip any with present: false, except
   * otherElements entries which are always present by construction).
   */
  elementOrder: string[];
}

export interface AnalyzeReferenceStyleParams {
  referenceImageUrl: string; // the design to match - content, hierarchy, colors, structure all come from here
  currentCompositeUrl: string; // the REAL photo+logo this design will be rendered onto right now - sizing/fit
                                // decisions must account for this actual canvas, not just an assumption from
                                // the reference alone
  /** Real defect found live: the reference's OWN brand wordmark (a
   *  footer lockup, a restyled repeat of the company/event name
   *  elsewhere in the layout) was being classified as a generic
   *  otherElements catch-all slot, so generateAdCopy wrote it "fresh"
   *  copy and the poster ended up with a second, AI-recreated logo next
   *  to the real one logo_composite already placed. Attaching the real
   *  logo file here gives the model a concrete visual anchor for "this
   *  is the same brand identity" so it can recognize and exclude a
   *  restated copy of it, instead of guessing from text content alone. */
  logoUrl: string;
  /** Real bug found live: this call used to re-derive the design's
   *  STRUCTURE (does a CTA exist, what does the bottom section actually
   *  contain) completely fresh on every single poster retry within the
   *  same job - a genuinely ambiguous judgment call (is this bar a real
   *  CTA button, or just a labeled banner?) could and did come back
   *  DIFFERENTLY between two attempts on the identical reference image,
   *  leaving generation and verification disagreeing with themselves
   *  attempt to attempt (a real job's CTA appeared, then vanished, then
   *  relocated into an unrelated badge, across three tries on one
   *  reference). Passing the prior answer here switches the instruction
   *  from "read this fresh" to "confirm this, correct only a genuine
   *  mismatch" - anchored verification, not a blind re-guess. Omitted
   *  entirely on a job's first real read (nothing to anchor on yet). */
  previousStyle?: PosterStyleSpec;
}

export interface AnalyzeReferenceStyleResult {
  style: PosterStyleSpec;
  latencyMs: number;
  costInr: number;
}

/**
 * Looks at the user's own layout reference image and extracts its
 * actual STRUCTURE and design as data - not just colors/sizes within a
 * fixed template, but which elements even exist (a CTA button, a
 * multi-line multi-color headline, a bottom bar vs. a boxed card of
 * trust points with a highlighted price row) - so render-poster.ts can
 * genuinely match whatever layout pattern the reference uses instead of
 * forcing every reference into one fixed template shape. Confirmed
 * live this matters: one real reference (headline + subtext + CTA pill
 * + full-width footer bar) and another (4-line headline with one
 * highlighted line, no CTA at all, a card of trust items ending in a
 * highlighted price row, no bottom bar) are structurally different, not
 * just different colors of the same layout.
 *
 * Reads THREE images: the reference (for content/hierarchy/structure -
 * what elements exist and in what order), the actual current composite
 * this design has to fit onto (for size ratios specifically - a
 * font-size ratio judged only against the reference's own canvas can be
 * wrong for the real photo's actual available space), and the real
 * uploaded logo file (purely as a visual anchor so the catch-all pass
 * below can recognize and exclude a restated copy of the same brand
 * identity elsewhere in the reference - see logoUrl's own doc comment).
 * No backdrop-panel field: this pipeline never paints a code-drawn panel
 * behind the text at any stage - if the reference uses one, that's
 * base_asset's job to bake into the photo itself, not something this
 * spec describes for a later compositing step to reproduce.
 */
export async function analyzeReferenceStyle(params: AnalyzeReferenceStyleParams): Promise<AnalyzeReferenceStyleResult> {
  // See previousStyle's own doc comment for the real, live-confirmed bug
  // this preamble fixes: re-deriving structure fresh every retry let a
  // genuinely ambiguous judgment call (does a CTA button really exist
  // here) flip between attempts on the SAME reference image. Anchoring
  // on the prior answer and asking for confirmation-or-correction, not a
  // fresh read, is what keeps that judgment stable across retries while
  // still allowing a real, evidenced correction through.
  const verifyPreamble = params.previousStyle
    ? `You already analyzed this exact reference image once before and concluded the following structure (as JSON): ${JSON.stringify(params.previousStyle)}\n\nLook at the reference image again and CONFIRM this is still accurate - a later step found a possible problem with how something structural rendered (e.g. whether a CTA button genuinely exists, or exactly what the bottom/other-elements section contains), so it is worth a real second look specifically at those kinds of questions. Only change a field if you find a genuine, clear mismatch against what the image actually shows - do NOT casually re-interpret or second-guess a judgment call that was already reasonable just because you are looking again; a coin-flip-close call should be left exactly as it was. If you do change something, you must be correcting a real, visible error, not swapping in a different equally-valid reading. Keep every field you are not actively correcting exactly as it was in the JSON above, including every numeric ratio - do not silently redraft the whole thing.\n\n`
    : '';
  const instruction = `${verifyPreamble}Analyze the REFERENCE image (first image below) as a design spec to replicate on the CURRENT image (second image below, the real photo+logo this design is being built onto right now), at the CURRENT image's own canvas size. First figure out WHICH elements are actually present in the reference (don't assume a fixed template - references vary a lot: some have a standalone CTA button, some don't; some have a bottom bar of trust points, some have a boxed card instead, some have neither and just a plain bulleted list, some have a completely different structure like a promo badge next to a stat grid). Then estimate every size as a ratio relative to the CURRENT image's own width or height (not the reference's) - e.g. a headline that would read proportionally as roughly 6% of the current image's width -> 0.06 - since the two canvases may differ, and it's the current one this design actually has to fit onto. Judge this the way a designer eyeballs proportions.

CRITICAL - do not force what you see into a template you already expect. Two specific things real references get wrong if you assume a fixed shape:
1. A headline's lines do NOT always share one font. Judge each line's font weight, style, and color completely independently - a reference can have a lighter, different-font lead-in line followed by a bold, completely different display-font punchline on the next line. Never assume uniformity across a headline just because that's common.
2. The bottom info block does NOT always look like a trust list with checkmarks. It might be a plain bulleted list with round dots and no background box at all, or a two-zone layout (a colored promo/offer badge next to a separate stat grid where each item stacks a big number over a small label), or something else entirely. Describe what you ACTUALLY see, in your own words, in the layoutDescription field - do not default to "checkmark bar" because that's a common ad pattern if the reference doesn't actually show one.

Look specifically at:
- Left margin: where the headline/CTA/card's left edge sits, as a fraction of image width.
- Spacing between elements: gap below the logo before the headline starts, gap between headline and subtext, gap after the subtext (or after the headline if there's no subtext) before the next element (CTA or trust list), and gap between the CTA and the trust list if both exist. Judge each as a ratio the same way you judge font sizes - compare the visual gap to the image height.
- Headline (the largest, most prominent text block): how many separate lines it's broken into, left or center aligned overall, and then for EACH line separately: font size ratio, font weight (400=regular, 600=semibold, 700=bold, 800=extra bold - judge by stroke thickness), a specific description of its actual typographic character (condensed or wide, italic/slanted or upright, script/handwritten/display/geometric feel, serif or sans as part of that description, letter-spacing) written specifically enough that someone could pick the right real font family from your description alone, its color - either a single flat hex color, or, if the line is filled with a visible gradient (e.g. gold fading to white, one color blending into another across the letters), say so explicitly and give both the start and end hex colors and the fade direction - AND, as part of this same description, explicitly note whether this text has any shadow, glow, or outline treatment, or renders completely flat with none. Most ad text is flat - do not assume a shadow or glow exists unless you can genuinely see one in the reference; state plainly "no shadow, flat" when that's what you see, rather than omitting the observation.
- Subtext: whether it's present at all, and if so its font size, weight, the same kind of specific typographic-character description as headline lines, its color (flat or gradient, same as above), and alignment.
- CTA button: whether a standalone button/pill exists at all, separate from any trust-points card AND separate from a bottom bar that itself functions as the call-to-action (a full-width promo/info bar is NOT a CTA button just because it's the most prominent bottom element - only count an actual distinct button/pill shape). If yes: total height ratio, corner radius ratio (0 if sharp corners), fill color, label text/color/weight, a specific description of the label's typographic character (same kind of description as headline lines, including whether it has any shadow/glow or is flat), whether it has a second band inside it for a price, that band's colors, font size ratio, text alignment, and the horizontal text padding inside the button as a ratio of image width. If no standalone button exists, say so plainly - do not invent one because ads commonly have them.
- The bottom info block, however it's actually structured: how many distinct items it contains; write a genuinely detailed layoutDescription in your own words describing its REAL visual structure (zones, colors, whether items are stacked value-over-label vs. side-by-side, whether there's a box/background at all, dividers, icons) - this is the most important field for this block, be thorough; separately, the closest matching icon style per item ("checkmark-filled", "checkmark-outline", "flat-checkmark" for a plain check glyph with no badge, "bullet-dot" for a plain round bullet with no check meaning, "custom" for anything else distinctive, or "none"); the closest matching presentation ("bar" = full-width bar usually bottom-pinned, "card" = a boxed list with a background, "inline" = a plain list directly on the photo with no box at all, "none" if this block doesn't exist); background/text/divider colors if applicable; font weight and size ratio; icon/dot color and size ratio; gap between icon and text. Separately: whether there's a highlighted price/offer row as part of a 'card' list (distinct from a CTA's price band) - if so its background, text color/weight, height ratio.
  IMPORTANT distinction, a real defect found live: trustList is for GENERIC, interchangeable marketing reassurance phrases (e.g. "24/7 support", "Free cancellation", "Verified reviews") - phrases that could apply to nearly any campaign. If the row instead shows SPECIFIC factual campaign info (a real location, a real date, a real price, a real stat) - even if it's styled with the exact same icon+text-row visual pattern - it is NOT a trust list, it belongs in otherElements as its own entry with parts, exactly like the date/location chip example in the catch-all section below. A pin-icon+city next to a calendar-icon+date is a location+date chip, never a trust list, regardless of how visually similar the row looks to one.
- A separate promo/offer badge: is there a distinct small badge or pill element (e.g. a percent-off icon with a short label like "EARLY BIRD SALE") that sits alongside the info block as its own visual piece, not inside a card list as a price row and not a CTA button? If yes, describe its visual container (shape, color, icon) in promoBadge.description - not its text, that's generated separately. If no, say so plainly.
- Overall ("textColumnWidthRatio"): judged against the CURRENT image's ACTUAL subject position (not the reference's) - the MAXIMUM text-column width, as a ratio of canvas WIDTH measured from the left margin, that GUARANTEES no overlap with the photo's subject, with a real safety margin. This becomes a hard boundary in the final render, not a soft description - every piece of text (headline, subtext, CTA, trust list) will be constrained to stay within it. If in doubt, judge narrower (more conservative) rather than wider - an undersized text column is a minor issue, but text overlapping the subject is a hard failure.
- Separately ("centerXRatio"), a real defect found live: do NOT assume this is just the midpoint of the text column above - that column exists only to keep text off a side-by-side photo subject, and for a reference where the subject sits BELOW the text instead (text spans close to the FULL canvas width, with the photo underneath), the true visual center is nowhere near that column's midpoint - it is close to the canvas's own true center instead. So judge this directly, by eye, from the reference's actual layout: if you drew a vertical line through where the centered content (headline/subtext/etc, wherever align is "center") actually balances left-to-right, where would that line sit, as a ratio of the CURRENT image's canvas width? Judge this the same way for every kind of composition - side-by-side, subject-below, full-bleed, anything else - never assume it must relate to marginXRatio or textColumnWidthRatio at all. If nothing in this design is center-aligned, still give your best estimate of a reasonable center point (it will go unused).
- Background pattern ("backgroundPattern"): is there a large-scale word or short phrase repeated/tiled across a region of the composition purely as a decorative TEXTURE, not meant to be read as a discrete line of copy (e.g. a giant outlined brand word repeated diagonally behind the subject, faded or low-opacity lettering tiled across a color panel)? This is different from every other text field above - it has no single position, it repeats. If present: read the literal repeated word straight off the reference (never invent one), describe the container it sits within if there is a distinct one (a color-block panel, a gradient region - describe its own shape/color/extent; empty string if the texture sits directly on the photo with no distinct panel), describe the word's own typographic treatment (outlined/hollow vs filled, weight, roughly how large/dense the repeats read), its color, and how faded/subtle vs solid it reads as an opacity ratio 0-1. If no such texture exists, set present: false and leave the other fields as reasonable empty defaults - do not invent one just because the reference has SOME background design element; a plain solid or gradient color block with no repeated lettering on it is not this field (photo-baked treatments like that are a separate, earlier pipeline stage's concern, not this one).
- CRITICAL exclusion for the catch-all pass below, a real defect found live: the third image attached is the actual brand logo file for THIS campaign - it is already being placed on the final poster by a separate, deterministic step, completely independent of this analysis. Do NOT create an otherElements entry for any design element in the reference whose content is simply that same brand/company/event identity restated as text elsewhere in the layout - a footer wordmark, a stacked two-line lockup, a tagline that is just the brand name again in a different font or color, anything that reads as "another version of the logo." Extracting one causes the pipeline to render a second, AI-recreated logo next to the real one. This exclusion is narrow and specific to the SAME brand as the attached logo image only - a genuinely different co-branding partner name (e.g. "Presented by" a different, unrelated company), a location/date chip, an offer badge, a stat grid, or any other campaign-specific content is NOT covered by this exclusion and must still be captured normally below.
- Finally, a catch-all pass (subject to the exclusion above): look for any OTHER distinct design element anywhere in the composition that isn't covered by any category above - e.g. a secondary partner/co-branding badge under the logo, a ribbon, a seal, a small tag, a date/location chip. For each one you find:
  - Describe its overall container (shape, border, background fill) in "description", and its position specifically ("positionDescription", e.g. "directly below the logo, left-aligned to the text column" - never vague).
  - Give it a real "align" - "left" or "center" - judged independently per element, the same way headline/subtext/CTA alignment is judged: is this element's content (icon+text together, as a whole) positioned flush to the text column's left edge, or horizontally centered within the text column? A reference can genuinely center its headline but left-align a footer bar, or the reverse - never assume every element shares the same alignment, and never default to one without actually looking.
  - Give it a real numeric anchor, judged against the CURRENT image the same way every other element is: "approxYRatio" (its vertical center as a fraction of canvas height), "approxHeightRatio" (its height as a fraction of canvas height), "gapAboveRatio" (gap from whatever sits directly above it, fraction of canvas height).
  - Break it into "parts" - ordered left-to-right (or top-to-bottom) sub-pieces, each judged independently, the same way you judge each headline line independently. Most elements have exactly one part. Some genuinely have several with different fonts/colors (e.g. a plain-sans label, then a colored icon-box, then a serif wordmark, in that order) - if so, record each part separately, in the order it actually reads, not merged into one description. For each part: its own styleDescription (typographic or icon character), its own color, and "text" - the literal text visible in the reference for that part, or null if it's a pure icon/glyph with no wording of its own. CRITICAL, a real defect found live: a short monogram or initialism (e.g. 2-3 capital letters in a colored box, like a company's abbreviated mark) is STILL text standing for a real name - it is NOT a pure decorative icon just because it's short and box-shaped. If a part shows ANY letters or initials, however brief, treat it as hasText: true and apply the no-real-name rule below to it - never classify a real company's monogram as a pure icon/glyph (text: null, hasText: false) just because it visually resembles one. Set "hasText" per part: true if that part needs a short GENERIC label generated fresh for the new campaign (never invent or copy a specific real partner/brand name, initials, or monogram you see in the reference - if a part shows a real partner's name or initials, still set hasText: true but do not write that real name/initials into "text"; leave "text" as a neutral placeholder, the actual generic wording is generated separately, never by you here), false ONLY for a part with zero letters of any kind (a pure shape, line, or non-alphabetic glyph).
  - If there is nothing else beyond what you've already described, return an empty array - do not invent an element that isn't there.
- Reading order: after everything above, list the REAL top-to-bottom (or logical) order these blocks actually appear in the reference, as "elementOrder": an array using exactly these names where applicable - "headline", "subtext", "cta", "trustList", and "otherElements[N]" (N = that entry's index in the otherElements array, e.g. "otherElements[0]") - only for elements that are actually present. Do not assume headline/subtext/cta/trustList is always the right order - judge the reference's own actual vertical sequence, which can genuinely differ (e.g. a bulleted trust list can sit ABOVE the CTA in some references).
- Visual reference boxes: every element below gets a "visualReference" object with a "box" (its exact bounding box in the reference image) and a "recommended" flag, but the two are handled differently depending on the element:
  - Headline (as a whole block, not per-line), subtext, and CTA: these ALWAYS get attached as real font references to a later generation step, regardless of how simple or ordinary the font looks - do NOT skip this because the font seems common. Give an accurate "visualReference.box" for each of these unconditionally (still set "recommended": true on these three, as a formality - it is not actually used as a gate for them).
  - The bottom info block and EACH catch-all element: here, make a real judgment - "visualReference.recommended" - is this element's look simple enough that the fields you already wrote above fully capture it (a flat solid color, a plain single-zone layout), or is it complex enough (a multi-zone layout, several visual parts, an unusual icon treatment) that attaching an actual picture of it would help significantly more than words alone? Set true only for the latter - be selective here, most of these should be false. Only give a real box when true; when false, still return a box object with any placeholder numbers - it will be ignored.
  - For EVERY box (mandatory or optional): this ONE field, unlike every other ratio in this entire response, must be a ratio of the REFERENCE image's OWN width/height (the first image below), NOT the current image - since it is only ever used to crop the reference image itself for a style reference, never to size or position anything on the output canvas.

If an element is absent, still return its object with reasonable defaults and its "present"/"itemCount"/"iconStyle" field set to indicate absence (present: false, itemCount: 0, iconStyle: "none", presentation: "none" as appropriate) - never omit a key.

Respond ONLY with JSON matching this exact shape: {"marginXRatio": number, "spacing": {"logoToHeadlineGapRatio": number, "headlineToSubtextGapRatio": number, "afterTextBlockGapRatio": number, "ctaToTrustListGapRatio": number}, "headline": {"lineCount": number, "align": "left"|"center", "lines": [{"fontSizeRatio": number, "fontWeight": number, "styleDescription": string, "color": {"type": "solid"|"gradient", "color": string, "gradientTo": string, "gradientDirection": "horizontal"|"vertical"|"diagonal"}}], "visualReference": {"recommended": boolean, "box": {"xRatio": number, "yRatio": number, "widthRatio": number, "heightRatio": number}}}, "subtext": {"present": boolean, "fontSizeRatio": number, "fontWeight": number, "styleDescription": string, "color": {"type": "solid"|"gradient", "color": string, "gradientTo": string, "gradientDirection": "horizontal"|"vertical"|"diagonal"}, "align": "left"|"center", "visualReference": {"recommended": boolean, "box": {"xRatio": number, "yRatio": number, "widthRatio": number, "heightRatio": number}}}, "cta": {"present": boolean, "heightRatio": number, "cornerRadiusRatio": number, "fillColor": string, "labelTextColor": string, "labelFontWeight": number, "labelStyleDescription": string, "hasPriceBand": boolean, "priceBandColor": string, "priceTextColor": string, "priceFontWeight": number, "fontSizeRatio": number, "textAlign": "left"|"center", "textInsetRatio": number, "visualReference": {"recommended": boolean, "box": {"xRatio": number, "yRatio": number, "widthRatio": number, "heightRatio": number}}}, "trustList": {"present": boolean, "itemCount": number, "layoutDescription": string, "iconStyle": "checkmark-filled"|"checkmark-outline"|"flat-checkmark"|"bullet-dot"|"custom"|"none", "presentation": "bar"|"card"|"inline"|"none", "heightRatio": number, "cardWidthRatio": number, "cardCornerRadiusRatio": number, "backgroundColor": string, "dividerColor": string, "textColor": string, "fontWeight": number, "fontSizeRatio": number, "checkmarkBadgeColor": string, "checkmarkIconColor": string, "checkmarkSizeRatio": number, "iconTextGapRatio": number, "iconOffsetRatio": number, "rowHeightRatio": number, "priceRowHeightRatio": number, "cardPaddingXRatio": number, "priceRow": {"present": boolean, "backgroundColor": string, "textColor": string, "fontWeight": number}, "promoBadge": {"present": boolean, "description": string}, "visualReference": {"recommended": boolean, "box": {"xRatio": number, "yRatio": number, "widthRatio": number, "heightRatio": number}}}, "textColumnWidthRatio": number, "centerXRatio": number, "backgroundPattern": {"present": boolean, "word": string, "containerDescription": string, "styleDescription": string, "color": {"type": "solid"|"gradient", "color": string, "gradientTo": string, "gradientDirection": "horizontal"|"vertical"|"diagonal"}, "opacityRatio": number}, "otherElements": [{"description": string, "positionDescription": string, "align": "left"|"center", "approxYRatio": number, "approxHeightRatio": number, "gapAboveRatio": number, "parts": [{"text": string, "hasText": boolean, "styleDescription": string, "color": {"type": "solid"|"gradient", "color": string, "gradientTo": string, "gradientDirection": "horizontal"|"vertical"|"diagonal"}}], "visualReference": {"recommended": boolean, "box": {"xRatio": number, "yRatio": number, "widthRatio": number, "heightRatio": number}}}], "elementOrder": string[]}`;

  const images: VisionImageInput[] = [
    { url: params.referenceImageUrl, label: 'Reference - the design to match (content, hierarchy, colors, structure)' },
    { url: params.currentCompositeUrl, label: 'Current image - the real photo+logo this design is being built onto right now; judge every size ratio against THIS canvas' },
    { url: params.logoUrl, label: 'The actual brand logo file for this campaign - already placed on the final poster by a separate step. Use this ONLY to recognize when a design element elsewhere in the reference restates this same brand identity (see the catch-all exclusion above) - never treat this image as something to copy into the design yourself.' },
  ];
  // Low temperature: this is an "observe and describe what's actually
  // there" call, not a creative one - see callChatModel's doc comment
  // for the real run-to-run inconsistency this addresses.
  const { parsed, latencyMs } = await callChatModel(instruction, images, 0.2);

  return {
    style: parsed as PosterStyleSpec,
    latencyMs,
    costInr: VISION_COST_INR_PER_CALL,
  };
}

/**
 * No fixed archetypes, no locked pixel geometry. Every earlier version
 * of this spec forced the reference into one of a small set of
 * categories and a ratio-based exclusion-zone box, trusted blindly by
 * every downstream stage before the actual photo even existed. Real
 * defect this caused: two structurally different references (a
 * bookshelf portrait, a wide lifestyle shot) both got flattened into
 * the same coarse bucket, and the exact box that bucket implied often
 * didn't match where the generated photo's own clean space actually
 * ended up. This spec now only carries a rich, freeform DESCRIPTION of
 * composition and background treatment - real geometry (where the logo
 * goes, where text goes) is decided later, by looking at the real
 * generated image, not this classification. See
 * logo-detection.stage.ts and render-poster.ts's getOrExtractStyle.
 */
export interface BaseLayerSpec {
  /** A specific, in-depth description of how THIS reference's
   *  composition actually works - where the subject sits, where the eye
   *  finds clean/uncluttered space, how the two relate - written to be
   *  specific enough to steer a brand-new photo generation toward the
   *  same compositional feel. Never a category label. */
  compositionGuide: string;
  /** Any non-text, non-logo design element the reference uses in or
   *  around the composition - a color block, a gradient, a subtle
   *  graphic/illustration accent, a textured surface - that is NOT part
   *  of the photograph's own natural content and needs to be replicated
   *  directly in the new photo generation to match this reference's
   *  look. Empty string if the reference is simply a plain, unaltered
   *  photograph with no added design treatment. This pipeline never
   *  paints such a treatment on afterward in a separate compositing
   *  step - if it exists, base_asset generates it as part of the photo. */
  backgroundTreatment: string;
  /**
   * Real defect found live: base_asset only ever used this spec's
   * exclusionZone (WHERE things go) and generated everything else -
   * color grading, lighting mood, setting, framing - from fixed
   * hardcoded constants, the same for every job regardless of what the
   * reference actually looked like. Confirmed live: a warm/golden,
   * tight-framed, tree-lined-path reference produced a cool/neutral,
   * wide-framed, open-road generation - right composition archetype,
   * completely wrong photographic identity. photoStyle is read straight
   * off the actual reference (both images - see classifyBaseLayer),
   * never generalized to one fixed look.
   */
  photoStyle: {
    colorGrading: string; // e.g. "warm golden-hour tones, cream/beige highlights, slightly desaturated shadows"
    lighting: string; // e.g. "soft warm natural sunlight, gentle directional golden-hour light"
    setting: string; // e.g. "outdoor tree-lined path, autumn foliage, urban park"
    framing: string; // e.g. "medium-close group shot, subjects filling most of frame width, eye-level"
  };
  notes: string; // one short sentence, free text - debugging/logging only, never read by layout code
}

export interface ClassifyBaseLayerParams {
  layoutReferenceUrl: string; // Reference-02 - the primary image to classify
  subjectReferenceUrl?: string; // Reference-01 - optional, subject/mood direction only
}

export interface ClassifyBaseLayerResult {
  spec: BaseLayerSpec;
  latencyMs: number;
  costInr: number;
}

/**
 * Replaces base_asset's old hardcoded "subject right two-thirds, clean
 * left third" assumption with a real per-job read of how THIS
 * reference's layout is actually built - same principle as
 * analyzeReferenceStyle (don't force every reference into one fixed
 * template), scoped narrowly to *where the photographic subject sits and
 * where clean space is reserved*, not the full text/color/spacing spec
 * poster already owns. Structured JSON output (response_format:
 * json_object, same as every other callChatModel caller) rather than
 * free-text parsing - validated deterministically by the calling stage
 * regardless (see base-layer-classification.stage.ts) for well-
 * formedness only, never for a fixed category the answer must match,
 * the same "never trust an AI value without checking it" discipline
 * used everywhere else in this pipeline, just checking a different
 * thing now that there's no enum to check against.
 */
export async function classifyBaseLayer(params: ClassifyBaseLayerParams): Promise<ClassifyBaseLayerResult> {
  const instruction = `Analyze this ad layout reference image IN DEPTH to understand how its PHOTOGRAPHIC composition is actually built - not by fitting it into a category, but by describing, specifically, what makes this particular composition work: where the subject sits, where the eye naturally finds clean/uncluttered space, how the two relate to each other, and how the whole frame reads as a single photograph. Do not describe the text itself (colors, fonts, copy) - only the photographic composition. Write this as "compositionGuide": a detailed, concrete paragraph specific enough that someone using ONLY your description (not this image) could generate a brand-new photo of a completely different subject that still composes the same way - not a generic label or category.

CRITICAL, a real defect found live: clean/uncluttered space is not always reserved on ONE SIDE (subject positioned left or right, the opposite side left clear) - many real compositions instead reserve a CENTERED band (e.g. the subject fills the lower portion of the frame, and the entire upper band, spanning close to the FULL width, is left clean for centered text sitting above it). Identify which of these two shapes actually applies here and say so explicitly, by name, in compositionGuide. If it is the centered-band case, this matters even more than usual: any secondary background element within that band (a landmark, a building, a sign, any object) MUST be described as sitting visibly OFF to one side, or explicitly flagged as needing to move off to one side in the new generation - a tall or prominent element sitting dead-center in an otherwise-clean band still blocks centered text even when it is faded, blurred, or desaturated, because centered text has to pass directly through the frame's own true horizontal middle, not merely avoid one side of it. "Faded" and "off-center" are two different, both-necessary properties - never treat softening an element's contrast as a substitute for actually moving it off the centerline.

Then, separately, describe "backgroundTreatment": any non-text, non-logo design element the reference uses in or around the composition that is NOT simply part of the photograph's own natural content - a solid or gradient color block, a subtle graphic or illustration accent, a textured surface, anything that reads as an added design treatment rather than something the camera just happened to capture. Describe it specifically enough to be replicated directly in a new photo generation. Any element that spells out or forms letters, words, or numbers - no matter how large, faded, stylized, translucent, or purely decorative - counts as text and must NOT be described here, even if it reads as a background graphic accent rather than legible foreground copy (a giant faded wordmark behind the subject is still text - a separate later stage owns generating that lettering, never this field). CRITICAL, a real defect found live: this text exclusion applies ONLY to the literal lettering itself, never to a genuine non-text container it happens to sit on or inside - if a giant repeated wordmark is drawn on top of an otherwise-real color block, diagonal panel, or gradient region, you must still describe THAT underlying shape/color/extent here (that part is real, non-text background design and belongs in this field exactly like any other color block), simply omitting the lettering itself from your description. Only return an empty string here when there is truly no non-text element at all once the lettering is set aside - never as a shortcut because a wordmark happens to be involved. If the reference is simply a plain, unaltered photograph with no non-text treatment at all, also return an empty string - do not invent one.

Then describe the photo's actual STYLE - this is a separate photo of a DIFFERENT subject/scene that needs to be generated to match this reference's look and feel, so describe it specifically enough that someone who has never seen this image could recreate its visual character:
- Color grading: the actual color palette and tonal treatment (e.g. warm golden-hour tones with cream highlights, cool neutral daylight, desaturated overcast, high-contrast punchy colors) - be specific about warm vs cool, saturated vs muted, bright vs moody.
- Lighting: the quality and direction of light (e.g. soft warm directional sunlight from one side, flat even overcast light, harsh midday sun, warm indoor lamp light) - not generic "good lighting," the actual observable quality.
- Setting: the type of environment/location (e.g. tree-lined outdoor path, minimalist indoor studio, home office, urban street) - specific enough to guide where a new photo should be set.
- Framing: the shot distance and composition style (e.g. medium-close group shot filling most of the frame, wide environmental shot with lots of negative space, tight portrait crop) - how much of the frame the subject(s) occupy and from what distance/angle.

Respond ONLY with JSON matching this exact shape: {"compositionGuide": string, "backgroundTreatment": string, "photoStyle": {"colorGrading": string, "lighting": string, "setting": string, "framing": string}, "notes": string}`;

  const images: VisionImageInput[] = [
    { url: params.layoutReferenceUrl, label: 'Layout reference (Reference-02) - classify the composition from this image' },
  ];
  if (params.subjectReferenceUrl) {
    images.push({
      url: params.subjectReferenceUrl,
      label: 'Subject/photo direction reference (Reference-01) - context only, for reasoning about where the photographic subject will likely sit; do not classify structure from this image directly',
    });
  }

  // Low temperature: this is an "observe and describe what's actually
  // there" call, not a creative one - see callChatModel's doc comment
  // for the real run-to-run inconsistency this addresses.
  const { parsed, latencyMs } = await callChatModel(instruction, images, 0.2);

  return {
    spec: parsed as BaseLayerSpec,
    latencyMs,
    costInr: VISION_COST_INR_PER_CALL,
  };
}

/**
 * Dimension-expansion recomposition planning (§6.6 dimension_9x16 /
 * dimension_4x5 / dimension_1.91x1). Real defect this replaces: those
 * three stages used to send Gemini one hardcoded, per-job-blind one-
 * liner ("Recompose this approved poster into {dimension}...") with no
 * idea what text or background the poster actually contains - which is
 * exactly the failure mode that produced a duplicated, garbled headline
 * and a visibly stretched subject when this was tested manually against
 * a real poster. This is now a two-step, different-model plan-then-
 * generate: GPT-4.1 vision LOOKS at the actual approved poster and
 * transcribes it (structured JSON, never freeform prose it might
 * silently vary) - a different model from the one that will do the
 * actual recomposition (gemini-3-pro-image), same "never self-graded /
 * never self-planned" discipline this whole pipeline already uses
 * everywhere else. `buildDimensionRecompositionPrompt` then
 * deterministically assembles the final Gemini-facing prompt from that
 * transcription in code - never trusting the vision call's own prose to
 * BE the final instruction, the same "clamp/template it in code"
 * discipline `render-poster.ts`'s clampStyle() and
 * `poster-text-edit.ts`'s buildFullContextEditPrompt() already use for
 * the poster stage.
 */
export interface DimensionTranscription {
  logoText: string;
  headlineLines: string[];
  subtextText: string;
  locationPillText: string;
  ctaText: string;
  statRowItems: string[];
  otherText: string[];
  backgroundDescription: string;
}

export interface PlanDimensionRecompositionParams {
  posterUrl: string;
  dimensionLabel: string; // e.g. '9x16', '4x5', '1.91x1' - kept a plain string so this file doesn't need a shared-types dependency just for a label
  targetWidth: number;
  targetHeight: number;
  /** Only true for 9x16 - see buildDimensionRecompositionPrompt's doc
   *  comment for why this is deliberately dimension-specific. */
  includeSafeMargins: boolean;
  /** Whatever the stage's own buildPrompt() produced - on a first
   *  attempt that's just a short boilerplate sentence (harmless to
   *  repeat, reinforces the constraints below), on a retry it carries
   *  the previous attempt's real QA feedback. Deliberately not parsed
   *  or distinguished here - appended as neutral extra context either
   *  way, since correctly relaying real retry feedback matters far more
   *  than avoiding a little redundant reinforcement on a first attempt. */
  pipelineContext?: string;
}

export interface PlanDimensionRecompositionResult {
  prompt: string;
  latencyMs: number;
  costInr: number;
}

/** Real-world Stories/Reels safe-zone convention (Instagram/Facebook):
 *  the platform's own UI permanently covers roughly the top ~12% of the
 *  screen (profile picture, username, close button) and a slightly
 *  taller ~14% at the bottom (the reply/message input bar) - text or a
 *  CTA placed there is routinely obscured by chrome the app itself
 *  draws on top, regardless of how the creative is designed. Only
 *  applied to 9x16, never 4x5/1.91x1 - those aren't full-bleed vertical
 *  placements and have no equivalent platform chrome to avoid. */
const DIMENSION_SAFE_MARGIN_TOP_RATIO = 0.12;
const DIMENSION_SAFE_MARGIN_BOTTOM_RATIO = 0.14;

function quoteList(items: string[]): string {
  return items.map((item) => `"${item}"`).join(', ');
}

/** Exported for direct unit testing - pure/deterministic, no network
 *  call, so its exact output text (the safe-margin math especially) can
 *  be asserted without mocking anything. */
export function buildDimensionRecompositionPrompt(params: {
  transcription: DimensionTranscription;
  dimensionLabel: string;
  targetWidth: number;
  targetHeight: number;
  includeSafeMargins: boolean;
  pipelineContext?: string;
}): string {
  const t = params.transcription;
  const textLines: string[] = [];
  if (t.logoText) textLines.push(`- Logo/brand lockup: "${t.logoText}"`);
  if (t.headlineLines?.length)
    textLines.push(`- Headline, exactly these lines in this order, each appearing ONCE only: ${t.headlineLines.map((l) => `"${l}"`).join(' then ')}`);
  if (t.subtextText) textLines.push(`- Subtext: "${t.subtextText}"`);
  if (t.locationPillText) textLines.push(`- Location/date pill: "${t.locationPillText}"`);
  if (t.ctaText) textLines.push(`- CTA button: "${t.ctaText}"`);
  if (t.statRowItems?.length) textLines.push(`- Stat/feature row items: ${quoteList(t.statRowItems)}`);
  if (t.otherText?.length) textLines.push(`- Other text: ${quoteList(t.otherText)}`);

  const marginBlock = (() => {
    if (!params.includeSafeMargins) return '';
    const topPx = Math.round(params.targetHeight * DIMENSION_SAFE_MARGIN_TOP_RATIO);
    const bottomPx = Math.round(params.targetHeight * DIMENSION_SAFE_MARGIN_BOTTOM_RATIO);
    const bottomY = params.targetHeight - bottomPx;
    return `\n\nSAFE-ZONE REQUIREMENT (9x16 only, for Stories/Reels-style vertical placement where the platform's own UI permanently covers the top and bottom of the screen): leave the top ${topPx}px (~${Math.round(DIMENSION_SAFE_MARGIN_TOP_RATIO * 100)}% of the ${params.targetHeight}px canvas height, from y=0 to y=${topPx}) and the bottom ${bottomPx}px (~${Math.round(DIMENSION_SAFE_MARGIN_BOTTOM_RATIO * 100)}%, from y=${bottomY} to y=${params.targetHeight}) completely free of the logo, headline, subtext, CTA, stat row, and any footer/bottom bar - no text and no UI element of any kind in either band. Those two bands must show ONLY the extended base photo/background continuing naturally - the same subject and background already in the poster, just uninterrupted by any text or UI block. Every text/UI element must sit within the vertical band from y=${topPx} to y=${bottomY}.`;
  })();

  const contextBlock = params.pipelineContext ? `\n\nAdditional context from the pipeline: ${params.pipelineContext}` : '';

  // Real defect found live: the source poster is always 1:1 square, so
  // any target TALLER than it is wide (4x5, 9x16) adds new vertical
  // canvas beyond what the square composition already fills. Without
  // explicit guidance, the model's laziest fix is to dump ALL of that
  // extra space into one gap (typically between the subtext/pill and
  // the stat row) and leave the subject/monument group at its original
  // size - which reads as an empty, unbalanced hole in the middle of
  // the composition, exactly what a real 4x5/9x16 recomposition showed
  // when this was checked manually. 1.91x1 (wider, not taller, than the
  // square source) doesn't have this failure mode, so it's excluded.
  const compositionBalanceBlock =
    params.targetHeight > params.targetWidth
      ? `\n\nCOMPOSITION BALANCE - this canvas is taller than the square source, so there is new vertical space to fill thoughtfully, not just dump into one spot: do NOT concentrate all of the extra height into a single large empty gap (e.g. between the subtext/pill and the stat row) while everything else stays at its original size and spacing - that reads as an empty, unbalanced hole in the middle of the composition. Instead, either (a) redistribute the extra space evenly across every gap in the layout (logo-to-headline, headline-to-subtext, subtext-to-stat-row, stat-row-to-footer, and the margin around the subject), so the whole composition feels intentionally, evenly spaced, or (b) scale the subject-and-background photo group up somewhat so it fills more of the new frame with the same confident, full presence it has in the source, rather than shrinking relative to the taller canvas. The result must read as a full, premium, deliberately composed layout - never as a sparse or emptied-out one.\n`
      : '';

  return `Recompose this exact finished poster into a ${params.dimensionLabel} aspect ratio, ${params.targetWidth}x${params.targetHeight} pixels. This is a recomposition/outpainting task, not a redesign and not a from-scratch regeneration - the subject, logo, and every text element already exist and must be carried over as-is, only the canvas shape changes.

HARD CONSTRAINT - no stretching or distortion, of anything, anywhere:
- The subject's body, limbs, face, and proportions must look exactly as natural and correctly proportioned as they do in the source image - never stretch, elongate, or warp anything to fit the new canvas shape. If the new canvas has extra space, add that space as new background AROUND the subject - never by stretching the subject.
- Every background element (skyline, landmark, texture, gradient, pattern) must also never be stretched, squashed, or warped - extend the scene with plausible new content in the same style, never distort what already exists.
- Do not add any extra limbs, extra hands, extra people, duplicated body parts, or ghosting/doubled-edge artifacts anywhere in the image.

HARD CONSTRAINT - text must be reproduced exactly, with zero duplication or corruption:
${textLines.length ? textLines.join('\n') : '- (no text elements were detected on this poster - do not invent any)'}
Reproduce each line above EXACTLY ONCE - never repeat, duplicate, or re-use any word or line, and never alter spelling, punctuation, or casing.
${compositionBalanceBlock}
Background: ${t.backgroundDescription || 'match the existing background exactly, extended naturally to the new canvas size.'}${marginBlock}${contextBlock}

Extend the background naturally to fill the new canvas. The final image must read as one single continuous photograph with no visible seam anywhere, professional advertising-campaign quality. Output must be exactly ${params.targetWidth}x${params.targetHeight} pixels, aspect ratio ${params.dimensionLabel}.`;
}

export async function planDimensionRecomposition(
  params: PlanDimensionRecompositionParams
): Promise<PlanDimensionRecompositionResult> {
  const instruction = `Look at this exact finished poster image. You are planning - not performing - a recomposition of it into a new ${params.dimensionLabel} aspect ratio canvas. Your only job is to transcribe, EXACTLY as it appears, every piece of real text and every discrete UI element currently in the image, plus describe its background - this transcription will be used to instruct a different image model to reproduce this poster faithfully in a new canvas shape, so accuracy matters far more than eloquence.

Read every word of real text in the image and copy it out character-for-character - do not paraphrase, summarize, or correct it in any way, even if it looks unusual:
- The brand/event logo lockup text, if any
- The headline, as separate lines exactly as they visually appear (one string per line, in reading order)
- The subtext/body copy line(s) below the headline, if any
- Any location/date pill or badge text, if any
- The call-to-action button text, if any
- Any stat/distance/feature row items, if any - each as its own string, combining its number/label and its short caption if both are present (e.g. "3Km - Run For Fun")
- Any other standalone text element not covered above, if any

Also describe the BACKGROUND in enough visual detail that someone who has never seen this image could redraw it: the color palette and gradient direction, any diagonal panels/shapes, any monument/skyline/landmark silhouette and roughly where it sits, any texture or repeated pattern - everything that is NOT the main subject/photo and NOT text.

Respond ONLY with JSON matching this exact shape: {"logoText": string, "headlineLines": string[], "subtextText": string, "locationPillText": string, "ctaText": string, "statRowItems": string[], "otherText": string[], "backgroundDescription": string}. Use an empty string or empty array for anything that genuinely isn't present - never invent content that isn't really there.`;

  // Low temperature: this is a "transcribe exactly what's on the page"
  // call, not a creative one - same run-to-run-consistency reasoning
  // callChatModel's own doc comment gives for every other "observe and
  // describe" vision call in this file.
  const { parsed, latencyMs } = await callVisionModel(params.posterUrl, instruction, 0.2);

  const prompt = buildDimensionRecompositionPrompt({
    transcription: parsed as DimensionTranscription,
    dimensionLabel: params.dimensionLabel,
    targetWidth: params.targetWidth,
    targetHeight: params.targetHeight,
    includeSafeMargins: params.includeSafeMargins,
    pipelineContext: params.pipelineContext,
  });

  return { prompt, latencyMs, costInr: VISION_COST_INR_PER_CALL };
}

export interface EditPosterImageParams {
  imageBuffer: Buffer;
  /** Optional as of the full-context single-edit redesign: this pipeline
   *  no longer computes a region-restricted mask (no more editable/
   *  preserved-box geometry anywhere) - omitted, this is a full-image
   *  edit driven entirely by a rich, detailed prompt instead of a hard
   *  pixel boundary. The tradeoff is deliberate and accepted: there is
   *  no longer a technical guarantee the photo/logo survive untouched,
   *  only a well-specified prompt plus the downstream QA gate. */
  maskBuffer?: Buffer;
  /** Real visual style references (never the edit target) - e.g. a crop
   *  of the reference's own footer/badge/headline, so the model can see
   *  exactly what a complex element should look like instead of relying
   *  on prose alone. Confirmed live via a real paid spike call: the
   *  model correctly copies the STYLE of an attached reference image
   *  (layout, color, font, icon treatment) while still rendering the
   *  literal text this call's own `instruction` specifies, not the
   *  reference's own text - see poster-text-edit.ts's
   *  selectElementsToCrop/cropReferenceElement for how these are
   *  chosen and produced. Always sent AFTER imageBuffer in the request -
   *  the endpoint treats the first image as the edit target. */
  referenceImages?: Array<{ buffer: Buffer; label: string }>;
  instruction: string;
  size: '1024x1024' | '1024x1536' | '1536x1024';
}

export interface EditPosterImageResult {
  imageBuffer: Buffer;
  latencyMs: number;
  costInr: number;
}

// Pricing snapshot, same pattern as gemini.client.ts's MODEL_COST_INR -
// gpt-image-2 edit-call pricing at time of writing, "high" quality tier
// (quality is the explicit priority for this call, not cost, per this
// stage's own design decision - see the note at the call site).
// Approximate, not billing-API-verified per call; flagged here rather
// than silently treated as exact, same honesty standard as the Gemini
// pricing snapshot.
const IMAGE_EDIT_COST_INR_PER_CALL = 14.5;

/**
 * Real masked inpaint call - POST /v1/images/edits (not
 * /v1/images/generations, and not a chat/completions call like every
 * other function in this file). multipart/form-data, not JSON: image
 * and mask are real file parts, not base64 embedded in a JSON body.
 * No official `openai` SDK is installed in this repo (every other
 * provider call here is raw HTTP via the shared axios instance) - this
 * follows the same pattern using Bun/Node's native FormData and Blob
 * rather than adding the SDK as a new dependency just for this one call.
 *
 * Confirmed live before any of this was wired into a real pipeline
 * stage: a real /v1/images/edits call with model=gpt-image-2, a solid-
 * color base image, and a real alpha mask (top half transparent, bottom
 * half opaque) returned HTTP 200 with b64_json, and the decoded result
 * showed the edit landing ONLY in the transparent region while the
 * opaque region's original color was preserved exactly - confirms both
 * the endpoint/model combination and OpenAI's documented mask semantics
 * (alpha 0 = editable, alpha 255 = preserved) before any production
 * code depended on either. The mask is now optional (see
 * EditPosterImageParams) - when omitted, the endpoint's documented
 * behavior is a full-image edit with no protected region, driven
 * entirely by `instruction`. As with the masked case originally, this
 * should be confirmed live against a real call before depending on it
 * in production, not assumed from documentation alone.
 *
 * Multi-image (`referenceImages`) confirmed the same way: a real paid
 * spike call sent the composite plus one crop of an unrelated reference
 * footer via `image[]`, and the result matched the crop's LAYOUT
 * (badge-left + big-number-over-label items, no icons) while rendering
 * only the fresh text the instruction specified - not the crop's own
 * literal text - and left the composite's own photo/logo untouched, no
 * blending between the two attached images.
 */
export async function editPosterImage(params: EditPosterImageParams): Promise<EditPosterImageResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const model = requireEnv('OPENAI_IMAGE_EDIT_MODEL');

  const form = new FormData();
  form.append('model', model);
  // image[] (array notation), not the bare `image` field - required to
  // attach more than one image in a single edit call, and the endpoint
  // still accepts it for the single-image case too. The FIRST image[]
  // part is always the composite being edited - confirmed live via a
  // real paid spike call that the endpoint treats it as the edit target
  // and any subsequent image[] parts as pure style reference, never
  // blended into or confused with the edit target.
  form.append('image[]', new Blob([Uint8Array.from(params.imageBuffer)], { type: 'image/png' }), 'composite.png');
  params.referenceImages?.forEach((ref, i) => {
    // JPEG, not PNG - see poster-text-edit.ts's cropReferenceElement,
    // which downsizes and re-encodes these specifically to keep this
    // call's multipart payload small; only the composite above (the
    // real edit target) needs to stay lossless.
    const safeLabel = ref.label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
    form.append('image[]', new Blob([Uint8Array.from(ref.buffer)], { type: 'image/jpeg' }), `reference-${i}-${safeLabel}.jpg`);
  });
  if (params.maskBuffer) {
    form.append('mask', new Blob([Uint8Array.from(params.maskBuffer)], { type: 'image/png' }), 'mask.png');
  }
  form.append('prompt', params.instruction);
  // Real defect found live: size:'auto' returned a DIFFERENT resolution
  // than the input composite (1254x1254 vs. a 1024x1024 input) on a real
  // run, which silently broke every downstream pixel-coordinate
  // assumption (the mask's own geometry, the OCR crop regions) until the
  // caller resized it back. Requesting the nearest real supported enum
  // to the input's own aspect ratio (computed by the caller, see
  // poster-text-edit.ts's pickEditSize()) is more likely to come back at
  // the size actually asked for - the caller still defensively resizes
  // the result to the exact input dimensions regardless, this just makes
  // that resize a no-op in the common case instead of a real correction.
  form.append('size', params.size);

  const startedAt = Date.now();
  const EDIT_TIMEOUT_MS = 120_000; // image edits run longer than this file's other calls; createHttpClient's default is 60s
  // Real bug found live: axios's own `timeout` option alone did NOT
  // reliably abort this call under Bun's http adapter once it started
  // regularly attaching multiple images (round 6's mandatory font
  // crops) - a real request hung indefinitely with zero error or retry
  // logged, well past 120s. AbortController is a second, independent
  // enforcement mechanism that doesn't depend on axios/Bun's internal
  // socket-timeout wiring - kept alongside `timeout` (belt-and-
  // suspenders) rather than replacing it, since which one actually
  // fires first doesn't matter, only that ONE of them reliably does.
  // The resulting cancellation has no `.response` (status undefined),
  // which createHttpClient's own retry logic already treats as a
  // retryable transient failure - no change needed there.
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), EDIT_TIMEOUT_MS);
  let response;
  try {
    response = await openai.post('/images/edits', form, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: EDIT_TIMEOUT_MS,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
  const latencyMs = Date.now() - startedAt;

  const b64 = response.data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI images/edits response did not contain b64_json');

  return {
    imageBuffer: Buffer.from(b64, 'base64'),
    latencyMs,
    costInr: IMAGE_EDIT_COST_INR_PER_CALL,
  };
}
