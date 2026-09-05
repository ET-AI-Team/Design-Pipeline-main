import sharp from 'sharp';
import axios from 'axios';
import type { Job } from '@prisma/client';
import type { StageDefinition } from './types';
import { uploadToCloudinary } from '../providers/cloudinary.client';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { handleStageResult, escalateTechnicalFailure, QA_PASS_THRESHOLD, MAX_CONTENT_RETRIES } from './handle-stage-result';
import { getOrExtractStyle } from './render-poster';
import { runFullContextEdit, buildVerificationRubric, type ExclusionBox } from './poster-text-edit';
import { computeLogoDimensions, clampLogoPosition, logoPlacementConstraints } from './logo-placement';
import {
  scoreImage,
  generateAdCopy,
  detectLogoPosition,
  verifyPoster,
  type AdCopy,
  type BaseLayerSpec,
  type PosterStyleSpec,
  type PosterVerificationFields,
} from '../providers/openai.client';
import { emitStatusChanged } from '../realtime/emitters';

/** Everything a poster attempt's own layerBreakdownJson carries -
 *  read back on the NEXT retry so it knows both what copy was actually
 *  rendered last time and which of its fields already passed. See
 *  mergeCopyWithPrevious/buildRetryFeedback below for how this is used. */
export interface PosterLayerBreakdown {
  style: PosterStyleSpec;
  adCopy: AdCopy;
  fields?: PosterVerificationFields;
}

/**
 * Real, confirmed-live bug this fixes: every retry used to regenerate
 * ALL of the ad copy from scratch, even fields that had already passed
 * verification - and since copy generation is a creative task with no
 * single correct answer, a field that was already fine (e.g. the
 * headline) would often come back worded completely differently on
 * retry. Combined with the old flat feedback (the entire previous
 * qaReasoning paragraph, which quoted the OLD headline as confirmed-
 * correct), the edit model ended up seeing two different versions of
 * the same field in one prompt and rendered the wrong one.
 *
 * The fix: pin every field that verifyPoster() already marked as
 * passing to its EXACT previous value, and only let a field that
 * actually failed take the freshly generated value. A passing field
 * never gets a second chance to accidentally get worse, and there's
 * never old/new text for the same field sitting in the same prompt at
 * once - whatever's there is either "unchanged, proven correct" or
 * "the one fresh attempt at fixing this specific thing."
 */
export function mergeCopyWithPrevious(
  freshCopy: AdCopy,
  previous: PosterLayerBreakdown | null,
  style: PosterStyleSpec
): AdCopy {
  if (!previous?.fields) return freshCopy; // first attempt - nothing passed yet to pin

  const { adCopy: prev, fields } = previous;
  // priceText is shared between two mutually-exclusive slots (a CTA's
  // own price band, or the trust list's highlighted price row) - pin it
  // against whichever field actually governs it for this design.
  const pricePassed = style.cta.present && style.cta.hasPriceBand ? fields.cta.pass : fields.otherElements.pass;

  return {
    headlineLines: fields.headline.pass ? prev.headlineLines : freshCopy.headlineLines,
    subtext: fields.subtext.pass ? prev.subtext : freshCopy.subtext,
    ctaLabel: fields.cta.pass ? prev.ctaLabel : freshCopy.ctaLabel,
    priceText: pricePassed ? prev.priceText : freshCopy.priceText,
    trustItems: fields.otherElements.pass ? prev.trustItems : freshCopy.trustItems,
    promoBadgeText: fields.otherElements.pass ? prev.promoBadgeText : freshCopy.promoBadgeText,
    otherElementTexts: fields.otherElements.pass ? prev.otherElementTexts : freshCopy.otherElementTexts,
  };
}

/**
 * Builds a short, targeted "fix only this" instruction from whichever
 * fields actually failed - replaces forwarding the entire previous
 * qaReasoning paragraph, which named things that already passed and
 * quoted now-superseded copy verbatim (the exact source of the
 * old/new-text confusion mergeCopyWithPrevious above fixes at the root;
 * this is the same fix applied to the prompt's own feedback text, so
 * there's nothing stale mentioned there either).
 */
export function buildRetryFeedback(fields: PosterVerificationFields): string | undefined {
  const failed: string[] = [];
  if (!fields.headline.pass) failed.push(`Headline: ${fields.headline.reasoning}`);
  if (!fields.subtext.pass) failed.push(`Subtext: ${fields.subtext.reasoning}`);
  if (!fields.cta.pass) failed.push(`CTA: ${fields.cta.reasoning}`);
  if (!fields.otherElements.pass) failed.push(`Trust points / additional element labels: ${fields.otherElements.reasoning}`);
  if (!fields.photoAndLogo.pass) failed.push(`Photo/logo: ${fields.photoAndLogo.reasoning}`);
  if (!fields.noExtraDecoration.pass) failed.push(`Unwanted decoration: ${fields.noExtraDecoration.reasoning}`);
  if (!fields.legibility.pass) failed.push(`Legibility/layout: ${fields.legibility.reasoning}`);
  // Not a copy field - mergeCopyWithPrevious has nothing to pin/swap for
  // this one, so an alignment-only failure retries with the exact same
  // (already-correct) words, just pushing harder on layout specifically.
  if (!fields.alignment.pass) failed.push(`Alignment: ${fields.alignment.reasoning}`);
  if (!failed.length) return undefined;
  return `Fix ONLY the following - every other element in this design already matched what was asked and must render EXACTLY the same as before, completely unchanged:\n${failed.map((n) => `- ${n}`).join('\n')}`;
}

/**
 * Real, confirmed-live gap this closes: handleStageResult's generic
 * PASS/RETRY/ESCALATE decision only ever looks at the aggregate
 * qaScore - a design with one genuinely failed field (a promo badge
 * showing the wrong text; inconsistent alignment) could still cross the
 * threshold on the strength of the other fields and reach human
 * approval with a known, real defect the field-level check had already
 * caught. One failed field must never be able to hide behind a decent
 * aggregate score - capped just under the pass threshold regardless of
 * whatever aggregate number the model itself proposed.
 */
export function capScoreIfAnyFieldFailed(
  fields: PosterVerificationFields,
  qaScore: number
): { effectiveQaScore: number; wouldHaveSilentlyPassed: boolean } {
  const allFieldsPassed = Object.values(fields).every((f) => f.pass);
  if (allFieldsPassed) return { effectiveQaScore: qaScore, wouldHaveSilentlyPassed: false };
  return {
    effectiveQaScore: Math.min(qaScore, QA_PASS_THRESHOLD - 1),
    wouldHaveSilentlyPassed: qaScore >= QA_PASS_THRESHOLD,
  };
}

/**
 * Runs a deterministic (non-provider-generation) stage synchronously.
 * `logo_composite` folds an AI position decision together with the
 * actual pixel placement and a real post-placement QA gate (see
 * runLogoCompositeStage) - it is deterministic RENDERING, not
 * deterministic quality, the same shape `poster` already is. `poster`
 * is likewise deterministic compositing (an image-edit call plus real
 * QA), not an unconditional pass.
 */
export async function runDeterministicStage(stageDef: StageDefinition, job: Job, attemptNumber = 1): Promise<void> {
  try {
    if (stageDef.name === 'poster') {
      await runPosterStage(job, attemptNumber);
      return;
    }
    if (stageDef.name === 'logo_composite') {
      await runLogoCompositeStage(job, attemptNumber);
      return;
    }
    throw new Error(`No deterministic implementation for stage "${stageDef.name}"`);
  } catch (err) {
    // Never let an inline stage's failure escape into whatever called
    // it. Real incident (job 3106ae7d): a crash inside the POSTER stage
    // propagated out of this function, up through logo_composite's
    // handleStageResult(), and into base_asset's BullMQ job - because
    // handle-stage-result.ts awaits runDeterministicStage() inside the
    // PREVIOUS stage's post-commit thunk. BullMQ then dutifully re-ran
    // base_asset, a stage that had already passed and already been paid
    // for, and its second QA run disagreed with its first - which is
    // what split the job into two live branches.
    //
    // The stage that actually failed is the one that gets escalated, and
    // nothing is rethrown. escalateTechnicalFailure() already writes the
    // ESCALATED row, moves the job to NEEDS_ATTENTION and emits both
    // socket events, so the job lands in the dashboard's Attention queue
    // recoverable via POST /jobs/:id/retry.
    //
    // No BullMQ-style technical retry here on purpose: transient
    // failures are already retried a layer down (lib/http-client.ts for
    // provider calls, cloudinary.client.ts for uploads), so anything
    // reaching this boundary is not transient.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, job_id: job.id, stage: stageDef.name, attempt_number: attemptNumber }, 'deterministic_stage_failed');
    await escalateTechnicalFailure(job.id, stageDef.name, attemptNumber, message);
  }
}

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002'; // Prisma's code for @@unique conflicts

/**
 * Claims one attempt of an inline stage by inserting its placeholder
 * StageAttempt row, exactly as dispatchStageJob() does for queued
 * stages. Returns false if this (jobId, stage, attemptNumber) is
 * already claimed, so the caller can bail out before spending anything.
 *
 * The placeholder deliberately leaves completedAt null - that is what
 * marks the attempt as in-flight for the dashboard, what
 * handleStageResult()'s atomic claim keys off, and what the orphan
 * reaper looks for.
 */
async function claimAttempt(jobId: string, stage: string, attemptNumber: number, startedAt: number): Promise<boolean> {
  try {
    await db.stageAttempt.create({
      data: {
        jobId,
        stage,
        attemptNumber,
        modelUsed: '', // filled in once the stage actually completes
        latencyMs: 0,
        costInr: 0,
        result: 'RETRY', // placeholder until the real pass/retry/escalate decision
        startedAt: new Date(startedAt),
      },
    });
    return true;
  } catch (err: any) {
    if (err?.code === UNIQUE_CONSTRAINT_VIOLATION) {
      logger.warn({ job_id: jobId, stage, attempt_number: attemptNumber }, 'deterministic_stage_attempt_already_claimed');
      return false;
    }
    throw err;
  }
}

function buildLogoPlacementRubric(campaignBrief: string): string {
  return `Score this ad photo out of 10, focusing specifically on the brand logo that has just been placed on it. Campaign context, for reasoning about what's in the photo: ${campaignBrief}

Judge:
- Does the logo's placement look natural and intentional, not awkward, cramped, or randomly dropped onto the frame?
- Is the logo fully legible and NOT covering anything important - faces, hands, key objects, or busy detail behind it?
- Is there anything else about this image that looks visually abnormal?

Score 3 or lower for a clearly bad placement (covering something important, illegible, awkwardly cropped or positioned) and state exactly why. Otherwise score normally (7-10) based on how natural and professional the placement looks.

Respond ONLY with JSON: {"qaScore": number (0-10), "qaReasoning": string}.`;
}

/**
 * Decides the logo's placement AND places it, in one deterministic
 * stage - folded together (rather than a separate AI "detect" stage
 * feeding a separate "composite" stage) specifically so a failed
 * post-placement QA can ask for a genuinely NEW coordinate on retry,
 * the same "the previous attempt's own feedback drives the next
 * attempt" pattern `runPosterStage` below already uses. Re-running a
 * placement at the exact same AI-chosen coordinate would fail
 * identically every time, so the decision and the execution have to
 * retry together, not as two independently-retried stages - trying to
 * keep them as separate registered stages ran into a real mechanical
 * conflict: the orchestrator always dispatches a next stage at
 * attemptNumber 1, which collides with this stage's own
 * (jobId, stage, attemptNumber) uniqueness the moment a retry is
 * needed.
 *
 * No painting, at any point, for any reason: whatever background/design
 * treatment the reference uses was already baked into base_asset's own
 * generation (see base-asset.stage.ts's backgroundTreatment prompt
 * text) - this stage only resizes and places the real logo pixels onto
 * the real photo. Nothing else.
 */
async function runLogoCompositeStage(job: Job, attemptNumber: number): Promise<void> {
  const startedAt = Date.now();

  // Claim this attempt BEFORE doing any paid work, and treat a
  // uniqueness conflict as "someone else already owns this attempt" -
  // the same guard dispatchStageJob() uses for queued stages, and the
  // same claim-first ordering runPosterStage below already uses.
  //
  // Real incident (job 3106ae7d): this row used to be created at the
  // very END of the stage, fully populated. Two advances raced (see
  // handle-stage-result.ts's atomic claim for why that was possible),
  // the second one re-ran the whole stage - a vision call, a sharp
  // composite and a second vision QA, all real spend - and only then hit
  // P2002 on the create, throwing after the money was gone. Claiming
  // first turns that into a free no-op instead of a paid crash, and
  // guarantees a row exists for escalateTechnicalFailure() to write to
  // (it silently gives up on P2025 when there is none).
  if (!(await claimAttempt(job.id, 'logo_composite', attemptNumber, startedAt))) return;

  // No logo supplied: record an explicit, zero-cost skip and hand the
  // base_asset image straight through unchanged.
  //
  // Deliberately still a recorded attempt rather than rewiring
  // base_asset.nextStageOnPass to point at 'poster'. Two reasons. The
  // dashboard's PIPELINE_STAGES is a fixed list containing
  // logo_composite, so a stage that never runs would render as
  // permanently pending and make every logo-free job look stuck. And
  // nextStageOnPass is a static string that handle-stage-result and
  // retry-stuck-job both read - making it a function of the job would
  // put a conditional in the middle of the orchestrator core to save
  // one cheap no-op row.
  //
  // assetUrl is job.baseAssetUrl, so handleStageResult's
  // "base_asset | logo_composite -> baseAssetUrl" write is a harmless
  // self-assignment and the poster stage reads the plain photo.
  if (!job.logoUrl) {
    await db.stageAttempt.update({
      where: { jobId_stage_attemptNumber: { jobId: job.id, stage: 'logo_composite', attemptNumber } },
      data: {
        modelUsed: 'skipped (no logo supplied)',
        latencyMs: Date.now() - startedAt,
        costInr: 0,
        qaScore: null,
        assetUrl: job.baseAssetUrl,
        qaReasoning: 'No logo was supplied for this job, so there was nothing to place. The base image passes through unchanged.',
        result: 'PASS',
      },
    });
    await handleStageResult(job.id, 'logo_composite', attemptNumber, {
      qaScore: QA_PASS_THRESHOLD,
      qaReasoning: 'No logo supplied - stage skipped.',
      assetUrl: job.baseAssetUrl ?? undefined,
      modelUsed: 'skipped (no logo supplied)',
      latencyMs: Date.now() - startedAt,
      costInr: 0,
    });
    return;
  }

  emitStatusChanged(job.id, 'LOGO_PLACEMENT_DETECTING');

  const [baseAssetBuffer, logoBuffer, previousAttempt] = await Promise.all([
    axios.get(job.baseAssetUrl!, { responseType: 'arraybuffer' }).then((r) => Buffer.from(r.data)),
    axios.get(job.logoUrl, { responseType: 'arraybuffer' }).then((r) => Buffer.from(r.data)),
    // Previous attempt's own post-placement QA feedback, if this is a
    // retry - read from the DB, not an in-memory value, since this
    // deterministic stage doesn't flow through buildPrompt()'s
    // previousFeedback parameter the way queued AI-generation stages do
    // (same pattern runPosterStage below already uses).
    attemptNumber > 1
      ? db.stageAttempt.findFirst({ where: { jobId: job.id, stage: 'logo_composite', attemptNumber: attemptNumber - 1 } })
      : Promise.resolve(null),
  ]);

  const { width: rawW, height: rawH } = await sharp(baseAssetBuffer).metadata();
  const canvasW = rawW ?? 1024;
  const canvasH = rawH ?? 1024;
  const { width: logoNaturalW, height: logoNaturalH } = await sharp(logoBuffer).metadata();

  const dims = computeLogoDimensions(canvasW, canvasH, logoNaturalW ?? 300, logoNaturalH ?? 100);
  const { marginXHint, topAreaMaxY } = logoPlacementConstraints(canvasW, canvasH);

  const detection = await detectLogoPosition({
    imageUrl: job.baseAssetUrl!,
    canvasWidth: canvasW,
    canvasHeight: canvasH,
    logoWidth: dims.width,
    logoHeight: dims.height,
    marginXHint,
    topAreaMaxY,
    feedback: previousAttempt?.qaReasoning ?? undefined,
  });
  const isValid = Number.isFinite(detection.x) && Number.isFinite(detection.y);
  const box = clampLogoPosition(detection.x, detection.y, dims, canvasW, canvasH);

  emitStatusChanged(job.id, 'LOGO_COMPOSITING');

  // fit: 'cover' (sharp's default) crops to fill the box exactly, which
  // is fine for photos but wrong for a logo - a wide, short logo (e.g.
  // 183x42) resized to a near-square detected box gets scaled up to
  // fill the box's height and cropped hard on both sides, since 'cover'
  // never letterboxes. Confirmed live: a real logo composited this way
  // rendered as an illegible blown-up fragment cut off at the canvas
  // edge. 'contain' scales to fit within the box and pads the rest with
  // transparency instead, so the whole logo stays visible.
  // Real quality issue found live: most uploaded logos are small
  // (e.g. 183x42) relative to a detected placement box on a 1024px
  // canvas, so this resize is usually an upscale, not a downscale -
  // even a modest ~1.4x enlargement visibly softens sharp text/edges.
  // kernel: 'lanczos3' (sharp's own best upscaling kernel, made
  // explicit rather than relying on the default) plus a light sharpen
  // pass afterward measurably improves perceived crispness for exactly
  // this text-logo-on-photo case, without over-sharpening artifacts at
  // this scale.
  const resizedLogo = await sharp(logoBuffer)
    .resize(box.width, box.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
    .sharpen({ sigma: 0.6 })
    .toBuffer();

  const composited = await sharp(baseAssetBuffer)
    .composite([{ input: resizedLogo, top: box.y, left: box.x }])
    .png()
    .toBuffer();

  const upload = await uploadToCloudinary(composited, { folder: `jobs/${job.id}` });

  // Real QA on the WHOLE composited image, not the unconditional pass
  // this stage used to give itself - a placement can be geometrically
  // valid (in the top area, in bounds) and still cover something
  // important or read as awkward, which only a look at the real
  // composited pixels can catch.
  const qa = isValid
    ? await scoreImage({
        imageUrl: upload.secureUrl,
        rubricPrompt: buildLogoPlacementRubric(job.prompt),
        referenceImages: [{ url: job.reference2Url, label: "The campaign's actual reference image - use it as a visual anchor for how natural/intentional a logo placement should look for this kind of design." }],
      })
    : { qaScore: 3, qaReasoning: `Model returned a non-numeric coordinate: ${JSON.stringify({ x: detection.x, y: detection.y })}. Fell back to (0, 0).`, costInr: 0 };

  const totalCost = detection.costInr + qa.costInr;
  const result = qa.qaScore >= QA_PASS_THRESHOLD ? 'PASS' : attemptNumber < MAX_CONTENT_RETRIES ? 'RETRY' : 'ESCALATED';

  // Update, not create - the row was already claimed at the top of this
  // function. completedAt is deliberately left alone here and set by
  // handleStageResult() below, so its atomic "only decide an attempt
  // once" claim still sees this attempt as in-flight.
  await db.stageAttempt.update({
    where: { jobId_stage_attemptNumber: { jobId: job.id, stage: 'logo_composite', attemptNumber } },
    data: {
      modelUsed: 'sharp (composite) + gpt-4.1 (position + QA)',
      latencyMs: Date.now() - startedAt,
      costInr: totalCost,
      qaScore: qa.qaScore,
      boundingBoxJson: box as object,
      assetUrl: upload.secureUrl,
      qaReasoning: qa.qaReasoning,
      result,
    },
  });

  await handleStageResult(job.id, 'logo_composite', attemptNumber, {
    assetUrl: upload.secureUrl,
    boundingBox: box,
    qaScore: qa.qaScore,
    qaReasoning: qa.qaReasoning,
    modelUsed: 'sharp (composite) + gpt-4.1 (position + QA)',
    latencyMs: Date.now() - startedAt,
    costInr: totalCost,
  });
}

function summarizeCopy(adCopy: AdCopy): string {
  return `Copy: "${adCopy.headlineLines.join(' ')}"${adCopy.subtext ? ` / "${adCopy.subtext}"` : ''}${adCopy.ctaLabel ? ` / CTA "${adCopy.ctaLabel}"` : ''}${adCopy.priceText ? ` (${adCopy.priceText})` : ''}${adCopy.trustItems.length ? ` / [${adCopy.trustItems.join(', ')}]` : ''}.`;
}

/**
 * Full-context single edit call onto the exact base+logo composite,
 * verified by a single GPT-4.1 vision call - see poster-text-edit.ts's
 * runFullContextEdit/buildVerificationRubric doc comments for the full
 * reasoning. Replaces the earlier masked-region approach: no mask, no
 * editable-box geometry, one detailed prompt describing the complete
 * target poster instead of a delta against a protected region. Part 1's
 * copy/style generation (getOrExtractStyle, generateAdCopy) is
 * unchanged and still the only source of "what the copy says" - this
 * function only changes HOW that copy gets turned into pixels and HOW
 * it's verified.
 *
 * No deterministic fallback: a final failed attempt escalates to
 * NEEDS_ATTENTION exactly like every other stage in this pipeline - a
 * visibly stuck job is preferable to a silently-degraded one here.
 */
async function runPosterStage(job: Job, attemptNumber: number): Promise<void> {
  const startedAt = Date.now();

  // Placeholder row first, same reason dispatchStageJob() does this for
  // queued stages: style extraction + copy generation + the edit call +
  // QA below all take real seconds, and the dashboard should show
  // "in progress" rather than nothing while that runs. Shares
  // claimAttempt() with logo_composite so both inline stages get the
  // same duplicate-claim protection.
  if (!(await claimAttempt(job.id, 'poster', attemptNumber, startedAt))) return;

  const baseLayerSpec = job.baseLayerSpecJson as unknown as BaseLayerSpec | null;
  if (!baseLayerSpec) {
    // Defensive - should never actually happen (base_layer_classification
    // always runs before poster and is deterministically validated
    // there). No fallback exists to reach for anymore, so this surfaces
    // loudly rather than guessing at composition/style.
    throw new Error(`poster stage: job ${job.id} has no baseLayerSpecJson - base_layer_classification must run first`);
  }

  // Fetched first, on its own, rather than inside the Promise.all below -
  // getOrExtractStyle now needs to know whether the LAST attempt's own
  // verification flagged anything structural before it can decide
  // whether to reuse, verify, or freshly re-read the style spec (see
  // that function's own doc comment). A local DB lookup is cheap enough
  // that losing this one from the parallel batch isn't a real cost.
  const previousAttempt =
    attemptNumber > 1
      ? await db.stageAttempt.findFirst({ where: { jobId: job.id, stage: 'poster', attemptNumber: attemptNumber - 1 } })
      : null;
  const previousLayerBreakdown = (previousAttempt?.layerBreakdownJson as unknown as PosterLayerBreakdown | null) ?? null;
  // Only these two fields are where a wrong STRUCTURAL read (does a CTA
  // really exist, what does otherElements really contain) would actually
  // show up as a failure - headline/subtext/legibility/photoAndLogo/
  // noExtraDecoration failures are wording or rendering problems, not
  // reasons to doubt the structure itself.
  const needsStructuralRecheck = !!(
    previousLayerBreakdown?.fields &&
    (!previousLayerBreakdown.fields.cta.pass || !previousLayerBreakdown.fields.otherElements.pass)
  );

  const [compositeBuffer, referenceImageBuffer, styleOutcome, logoAttempt] = await Promise.all([
    axios.get(job.baseAssetUrl!, { responseType: 'arraybuffer' }).then((r) => Buffer.from(r.data)),
    // For runFullContextEdit's reference-crop attachment (round 5) - a
    // real picture of a complex element (a co-branding badge, a footer)
    // transfers style far more reliably than prose alone. Fails open on
    // purpose: this is a genuinely optional enhancement, never allowed
    // to turn an otherwise-working job into a failure - a fetch error
    // here just means zero crops get attached, the same as today.
    axios
      .get(job.reference2Url, { responseType: 'arraybuffer' })
      .then((r) => Buffer.from(r.data))
      .catch(() => null),
    getOrExtractStyle(job, { needsStructuralRecheck }),
    // The logo's own placed box, so the prompt can tell the model
    // exactly where it already is and that it must stay untouched -
    // real defect found live in the earlier masked version: without
    // this, the model was free to paint over the logo entirely. That
    // risk is even more real now that there's no mask enforcing it at
    // the provider level - the prompt is the only thing protecting it.
    db.stageAttempt.findFirst({
      where: { jobId: job.id, stage: 'logo_composite', result: 'PASS' },
      orderBy: { attemptNumber: 'desc' },
    }),
  ]);

  const logoBox = (logoAttempt?.boundingBoxJson as ExclusionBox | null) ?? null;

  const { style } = styleOutcome;
  // Persisted immediately so the NEXT attempt (if this one doesn't pass)
  // reads it back via job.styleSpecJson - handleStageResult() always
  // re-fetches Job fresh from the DB before dispatching a retry, so this
  // write is guaranteed visible by the time runPosterStage runs again.
  await db.job.update({ where: { id: job.id }, data: { styleSpecJson: style as object } });
  const freshAdCopy = await generateAdCopy({
    brief: job.prompt,
    headlineLineCount: style.headline.lineCount,
    hasSubtext: style.subtext.present,
    hasCtaButton: style.cta.present,
    trustItemCount: style.trustList.itemCount,
    hasPriceLine: (style.cta.present && style.cta.hasPriceBand) || style.trustList.priceRow.present,
    hasPromoBadge: style.trustList.promoBadge.present,
    // Flattened per-part, not per-element (otherElements[i].parts[j]) -
    // the traversal order here (element order, then part order within
    // each element) must match poster-text-edit.ts's own consumption
    // order exactly, since otherElementTexts comes back as one flat
    // parallel array with no index metadata of its own.
    // Real gap found live: siblings of the SAME combined badge (e.g. a
    // pin+city+calendar+date pill) shared only the same description
    // prefix, nothing marked them as siblings explicitly - generateAdCopy
    // would dump all genuine content into the first sibling and invent
    // filler for the rest instead of leaving them blank. Naming sibling
    // count/position only when an element genuinely has more than one
    // text part.
    otherElementPrompts: style.otherElements.flatMap((el) => {
      const textParts = el.parts.filter((p) => p.hasText);
      return textParts.map((p, j) =>
        textParts.length > 1
          ? `${el.description} - this specific part (${j + 1} of ${textParts.length} text parts in this SAME combined element - these are siblings, not independent elements): ${p.styleDescription}`
          : `${el.description} - this specific part: ${p.styleDescription}`
      );
    }),
  });

  // Only the copy fields the LAST attempt's structured verification
  // actually flagged as failing take the fresh value above - everything
  // that already passed is pinned to its exact previous wording. See
  // mergeCopyWithPrevious's own doc comment for the real bug this fixes.
  const adCopy = mergeCopyWithPrevious(freshAdCopy, previousLayerBreakdown, style);

  // Targeted "fix only this" feedback built from whichever fields
  // failed, not the entire previous verdict - see buildRetryFeedback's
  // own doc comment.
  const feedback = previousLayerBreakdown?.fields ? buildRetryFeedback(previousLayerBreakdown.fields) : undefined;

  const edit = await runFullContextEdit(compositeBuffer, referenceImageBuffer, {
    campaignBrief: job.prompt,
    compositionGuide: baseLayerSpec.compositionGuide,
    backgroundTreatment: baseLayerSpec.backgroundTreatment,
    photoStyle: baseLayerSpec.photoStyle,
    logoBox,
    copy: adCopy,
    style,
    feedback,
  });
  const upload = await uploadToCloudinary(edit.imageBuffer, { folder: `jobs/${job.id}/poster` });

  const copySummary = summarizeCopy(adCopy);

  // Single vision call, always run - checks exact text correctness AND
  // that the photo/logo weren't altered together (see
  // buildVerificationRubric's doc comment for why the latter matters
  // more now that there's no mask enforcing it structurally). Returns
  // pass/fail PER FIELD (verifyPoster, not the generic scoreImage) so a
  // future retry can pin what already passed - see mergeCopyWithPrevious.
  const verification = await verifyPoster({
    imageUrl: upload.secureUrl,
    rubricPrompt: buildVerificationRubric(adCopy, style, !!job.logoUrl),
    referenceImages: [
      { url: job.reference2Url, label: "The campaign's actual reference image - use it as a visual anchor for overall style/fidelity, on top of the text checks below." },
      // Real gap found live: without this, the "photo/logo unaltered"
      // hard-fail check had no actual "before" image to compare against -
      // confirmed live, QA confidently stated the photo was unaltered
      // while the output was a visibly different photo entirely. This is
      // the real pre-edit composite, not the campaign reference above.
      { url: job.baseAssetUrl!, label: 'The exact photo+logo composite BEFORE this text edit - compare pixel-for-pixel against the submitted image to verify nothing about the photo, logo, or any object on it changed.' },
    ],
  });

  // freshAdCopy.costInr, not adCopy - the generation call itself was
  // paid for regardless of whether mergeCopyWithPrevious ended up
  // discarding some of its fields in favor of pinned previous values.
  const totalCost = styleOutcome.costInr + freshAdCopy.costInr + edit.costInr + verification.costInr;

  // Real, confirmed-live gap this closes: handleStageResult's generic
  // PASS/RETRY/ESCALATE decision only ever looks at the aggregate
  // qaScore - a design with one genuinely failed field (e.g. a promo
  // badge showing the wrong text, or inconsistent alignment) could still
  // cross the threshold on the strength of the other fields and get
  // waved through to human approval with a known, real defect. One
  // failed field must never be able to hide behind a decent aggregate
  // score - capped just under the pass threshold regardless of whatever
  // aggregate number the model itself proposed.
  const { effectiveQaScore, wouldHaveSilentlyPassed } = capScoreIfAnyFieldFailed(verification.fields, verification.qaScore);
  const qaReasoningText = wouldHaveSilentlyPassed
    ? `[A field-level check failed even though the aggregate score alone would have passed - forced to retry/escalate instead of silently approved.] ${verification.qaReasoning} ${copySummary}`
    : `${verification.qaReasoning} ${copySummary}`;

  await handleStageResult(job.id, 'poster', attemptNumber, {
    assetUrl: upload.secureUrl,
    qaScore: effectiveQaScore,
    qaReasoning: qaReasoningText,
    modelUsed: 'gpt-image-2 (full-context edit) + gpt-4.1 (style/copy/verification)',
    latencyMs: Date.now() - startedAt,
    costInr: totalCost,
    // Diagnosability: the extracted style + the MERGED copy (pinned
    // fields + freshly-fixed ones) that actually drove THIS attempt's
    // prompt, plus this attempt's own per-field verification result -
    // read back by mergeCopyWithPrevious/buildRetryFeedback on the NEXT
    // retry, if there is one.
    layerBreakdown: { style, adCopy, fields: verification.fields },
  });
}
