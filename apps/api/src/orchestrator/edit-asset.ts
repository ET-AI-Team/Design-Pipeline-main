import axios from 'axios';
import sharp from 'sharp';
import { db } from '../lib/db';
import { ApiError } from '../lib/api-error';
import { logger } from '../lib/logger';
import { requireEnv } from '../lib/env';
import { Semaphore } from '../lib/semaphore';
import { generateImage } from '../providers/gemini.client';
import { resizeToExactSize } from '../stages/generate-and-score';
import { uploadToCloudinary } from '../providers/cloudinary.client';
import { runFullContextEdit, buildVerificationRubric, prepareUserReferenceImage, type ExclusionBox } from './poster-text-edit';
import { planAssetEdit, type EffectiveSpec } from './plan-asset-edit';
import { verifyPoster, type AdCopy, type BaseLayerSpec, type PosterStyleSpec, type EditLane } from '../providers/openai.client';
import type { Job, DimensionJob } from '@prisma/client';
import type { EditTarget } from '@pipeline/shared-types';

/** The job shape editAsset() loads - the real Prisma Job plus the
 *  dimensionJobs it includes, so the helpers below keep that typing
 *  instead of inferring a bare Job and losing the relation. */
type JobWithDimensions = Job & { dimensionJobs: DimensionJob[] };

/** Caps concurrent provider calls from this endpoint specifically -
 *  unlike every other generation path in this pipeline, /edit has no
 *  BullMQ queue gating it, so without this a burst of simultaneous
 *  callers would fire an equally large burst of simultaneous calls. */
const editSemaphore = new Semaphore(Number(process.env.EDIT_CONCURRENCY ?? 8));

/** Hard cap on user-attached references, on top of the renderer's own
 *  MAX_REFERENCE_CROPS budget. Total stays well under the 16-image
 *  ceiling /v1/images/edits actually enforces. */
export const MAX_USER_REFERENCE_IMAGES = 4;

export interface EditAssetResult {
  assetUrl: string;
  lane: EditLane;
  reason: string;
  /** Present for poster edits: verifyPoster's per-field verdict.
   *  Recorded and surfaced as a warning, never used to gate or retry -
   *  the human reading the result is still the QA here. */
  verification?: { qaScore: number; qaReasoning: string; allFieldsPassed: boolean };
  /** True when already-generated dimensions were derived from the poster
   *  this edit just replaced, so they no longer match it. */
  dimensionsStale: boolean;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

/**
 * Resolves the CURRENT effective { style, adCopy } for a poster.
 *
 * This is the mechanism behind "every version is one generation from
 * clean": each edit patches the spec the LAST edit produced, so edit #2
 * builds on edit #1 instead of silently re-patching the original and
 * reverting it. Falls back to what the poster stage itself recorded when
 * no edit has happened yet.
 */
async function resolveEffectiveSpec(jobId: string, styleSpecJson: unknown): Promise<EffectiveSpec | null> {
  // Only a COMPLETED edit is a valid starting point - a failed or
  // in-flight row must never be inherited. Filtering "has a spec" in
  // code rather than in the WHERE: Prisma's JSON-null filtering needs
  // DbNull/JsonNull sentinels, and an edit that recorded no spec (an
  // older whole-canvas one) should fall through to the poster attempt
  // below rather than dead-end.
  const recentEdits = await db.assetEdit.findMany({
    where: { jobId, target: 'poster', resultAssetUrl: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { specJson: true },
  });
  const lastWithSpec = recentEdits.find((e) => e.specJson !== null && e.specJson !== undefined);
  if (lastWithSpec?.specJson) return lastWithSpec.specJson as unknown as EffectiveSpec;

  // No edits yet - the winning poster attempt's layerBreakdownJson holds
  // the exact style + copy that produced the current poster.
  const posterAttempt = await db.stageAttempt.findFirst({
    where: { jobId, stage: 'poster', result: 'PASS' },
    orderBy: { attemptNumber: 'desc' },
    select: { layerBreakdownJson: true },
  });
  const breakdown = posterAttempt?.layerBreakdownJson as unknown as { style?: PosterStyleSpec; adCopy?: AdCopy } | null;
  if (breakdown?.style && breakdown?.adCopy) return { style: breakdown.style, adCopy: breakdown.adCopy };

  // Last resort: the style cached on the Job row, with no copy recorded.
  // Without copy there is nothing to patch, so callers treat null as
  // "spec editing unavailable, use the pixel lane".
  if (styleSpecJson) return null;
  return null;
}

export async function editAsset(params: {
  jobId: string;
  target: EditTarget;
  instruction: string;
  /** Raw bytes of every image the user attached, already validated for
   *  type/size by the route. */
  referenceImageBuffers?: Buffer[];
}): Promise<EditAssetResult> {
  const job = await db.job.findFirst({
    where: { id: params.jobId, deletedAt: null },
    include: { dimensionJobs: true },
  });
  if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `No job with id ${params.jobId}`);

  const dimensionJob = params.target === 'poster' ? undefined : job.dimensionJobs.find((d) => d.dimension === params.target);
  const currentAssetUrl = params.target === 'poster' ? job.posterUrl : dimensionJob?.assetUrl;

  if (!currentAssetUrl) {
    throw new ApiError('VALIDATION_ERROR', 400, `No ${params.target} asset exists yet for this job to edit`, {
      field: 'target',
    });
  }

  // Validation above runs unqueued - no reason to make a caller with a
  // bad request wait behind slow in-flight edits.
  return editSemaphore.run(() => performEdit(job, params, currentAssetUrl, dimensionJob?.id));
}

async function performEdit(
  job: JobWithDimensions,
  params: { jobId: string; target: EditTarget; instruction: string; referenceImageBuffers?: Buffer[] },
  currentAssetUrl: string,
  dimensionJobId: string | undefined
): Promise<EditAssetResult> {
  const startedAt = Date.now();
  const userBuffers = (params.referenceImageBuffers ?? []).slice(0, MAX_USER_REFERENCE_IMAGES);

  // Spec-patch editing only applies to the poster - a dimension is a
  // recomposition of the poster with no spec of its own to patch.
  const spec = params.target === 'poster' ? await resolveEffectiveSpec(job.id, job.styleSpecJson) : null;
  const baseLayerSpec = job.baseLayerSpecJson as unknown as BaseLayerSpec | null;
  const canSpecEdit = params.target === 'poster' && !!spec && !!baseLayerSpec && !!job.baseAssetUrl;

  const edit = await db.assetEdit.create({
    data: {
      jobId: job.id,
      target: params.target,
      // The asset this render is actually built FROM. For a spec edit
      // that is the immutable base composite, not the poster being
      // replaced - the whole point.
      sourceAssetUrl: canSpecEdit ? job.baseAssetUrl! : currentAssetUrl,
      instruction: params.instruction,
    },
  });

  try {
    const result = canSpecEdit
      ? await specPatchEdit(job, params, spec!, baseLayerSpec!, userBuffers, currentAssetUrl)
      : await wholeCanvasEdit(job, params, currentAssetUrl, userBuffers);

    const upload = await uploadToCloudinary(result.imageBuffer, { folder: `jobs/${job.id}/edits` });

    if (params.target === 'poster') {
      await db.job.update({ where: { id: job.id }, data: { posterUrl: upload.secureUrl } });
    } else if (dimensionJobId) {
      await db.dimensionJob.update({ where: { id: dimensionJobId }, data: { assetUrl: upload.secureUrl } });
    }

    await db.assetEdit.update({
      where: { id: edit.id },
      data: {
        lane: result.lane,
        patchJson: (result.patch as object) ?? undefined,
        specJson: (result.spec as object) ?? undefined,
        verificationJson: (result.verification as object) ?? undefined,
        resultAssetUrl: upload.secureUrl,
        costInr: result.costInr,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });

    // Dimensions were recomposed from the poster this edit just replaced.
    // Flagged, never auto-regenerated: that would silently spend ~Rs38.
    const dimensionsStale = params.target === 'poster' && job.dimensionJobs.some((d) => !!d.assetUrl);

    logger.info(
      { job_id: job.id, target: params.target, lane: result.lane, cost_inr: result.costInr, latency_ms: Date.now() - startedAt },
      'asset_edit_completed'
    );

    return {
      assetUrl: upload.secureUrl,
      lane: result.lane,
      reason: result.reason,
      verification: result.verification,
      dimensionsStale,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.assetEdit
      .update({ where: { id: edit.id }, data: { errorMessage: message, latencyMs: Date.now() - startedAt, completedAt: new Date() } })
      .catch(() => undefined);
    throw err;
  }
}

interface EditRenderResult {
  imageBuffer: Buffer;
  lane: EditLane;
  reason: string;
  patch?: unknown;
  spec?: EffectiveSpec;
  verification?: EditAssetResult['verification'];
  costInr: number;
}

/**
 * The good path: translate the instruction into a validated patch against
 * the poster's current spec, then re-render the whole text layer from
 * Job.baseAssetUrl - the immutable photo+logo composite.
 *
 * gpt-image-2 still redraws the whole canvas here (there is no mask yet),
 * so the photo is not byte-preserved. What this DOES guarantee is that
 * every version sits exactly ONE generation from the pristine base rather
 * than stacking on the previous edit's output, which is what made
 * repeated edits visibly degrade before.
 */
async function specPatchEdit(
  job: JobWithDimensions,
  params: { instruction: string; target: EditTarget },
  current: EffectiveSpec,
  baseLayerSpec: BaseLayerSpec,
  userBuffers: Buffer[],
  preEditPosterUrl: string
): Promise<EditRenderResult> {
  const planned = await planAssetEdit({
    instruction: params.instruction,
    current,
    hasUserReferences: userBuffers.length > 0,
  });

  const [compositeBuffer, referenceImageBuffer, logoAttempt, userReferenceImages] = await Promise.all([
    fetchBuffer(job.baseAssetUrl!),
    fetchBuffer(job.reference2Url).catch(() => null),
    db.stageAttempt.findFirst({
      where: { jobId: job.id, stage: 'logo_composite', result: 'PASS' },
      orderBy: { attemptNumber: 'desc' },
      select: { boundingBoxJson: true },
    }),
    Promise.all(
      userBuffers.map(async (b, i) => ({
        buffer: await prepareUserReferenceImage(b),
        label: `user reference ${i + 1}`,
      }))
    ),
  ]);

  const rendered = await runFullContextEdit(
    compositeBuffer,
    referenceImageBuffer,
    {
      campaignBrief: job.prompt,
      compositionGuide: baseLayerSpec.compositionGuide,
      backgroundTreatment: baseLayerSpec.backgroundTreatment,
      photoStyle: baseLayerSpec.photoStyle,
      logoBox: (logoAttempt?.boundingBoxJson as ExclusionBox | null) ?? null,
      copy: planned.spec.adCopy,
      style: planned.spec.style,
      // For the pixel lane the spec is unchanged, so the user's raw words
      // are the only thing expressing what they want - forwarded through
      // the same channel a QA retry uses.
      feedback: planned.lane === 'pixel' ? `The user asked for this specific change: ${params.instruction}` : undefined,
    },
    userReferenceImages
  );

  // Recorded, not enforced. The pre-edit poster is attached so "did
  // anything else change?" is genuinely answerable - the same fix that
  // made the dimension QA honest.
  const upload = await uploadToCloudinary(rendered.imageBuffer, { folder: `jobs/${job.id}/edits/verify` });
  const verification = await verifyPoster({
    imageUrl: upload.secureUrl,
    rubricPrompt: buildVerificationRubric(planned.spec.adCopy, planned.spec.style),
    referenceImages: [
      { url: job.reference2Url, label: "The campaign's original reference design, for overall style fidelity." },
      { url: preEditPosterUrl, label: 'The poster BEFORE this edit - compare against it to confirm ONLY the requested change happened and nothing else moved.' },
    ],
  });

  return {
    imageBuffer: rendered.imageBuffer,
    lane: planned.lane,
    reason: planned.reason,
    patch: planned.patch,
    spec: planned.spec,
    verification: {
      qaScore: verification.qaScore,
      qaReasoning: verification.qaReasoning,
      allFieldsPassed: Object.values(verification.fields).every((f) => f.pass),
    },
    costInr: planned.costInr + rendered.costInr + verification.costInr,
  };
}

/**
 * Fallback for targets with no patchable spec - the three dimensions, or
 * a poster whose stage never recorded a layerBreakdown (older jobs).
 * Still Gemini here rather than gpt-image-2: without a spec there is no
 * structured instruction to build, and this path is a plain
 * "edit this image per this sentence" request, which is exactly what the
 * old /edit did. Dimensions get a real upgrade when the masked pixel lane
 * lands.
 */
async function wholeCanvasEdit(
  job: JobWithDimensions,
  params: { instruction: string; target: EditTarget },
  currentAssetUrl: string,
  userBuffers: Buffer[]
): Promise<EditRenderResult> {
  const referenceImageUrls = await Promise.all(
    userBuffers.map(async (b) => (await uploadToCloudinary(b, { folder: `jobs/${job.id}/edits/references` })).secureUrl)
  );

  const prompt = `You are making a targeted edit to this exact finished ad creative, based on the request below. Preserve everything the request doesn't ask you to change - do not alter any other text, wording, or layout element. Keep the same canvas dimensions and aspect ratio.

Requested change: "${params.instruction}"
${referenceImageUrls.length > 0 ? `\n${referenceImageUrls.length} additional reference image(s) are attached after the current asset - use them as the concrete visual target for this change (matching a color, shape, or style they show), never as content to copy wholesale into the design.\n` : ''}
Apply exactly this change, as precisely and naturally as possible, while keeping everything else faithful to the original.`;

  const generation = await generateImage({
    prompt,
    model: requireEnv('GEMINI_PRO_MODEL'),
    referenceImages: [
      {
        url: currentAssetUrl,
        role: 'The exact current version of this asset - edit it directly per the instructions above, preserving everything not explicitly asked to change.',
      },
      ...referenceImageUrls.map((url, i) => ({
        url,
        role: `An additional reference image supplied by the user for this edit (${i + 1} of ${referenceImageUrls.length}) - reflect its style, content, or detail as described in the instruction above. Style/content reference only, NOT the image being edited.`,
      })),
    ],
  });

  // Annotated rather than inferred: Buffer.from() narrows to
  // Buffer<ArrayBuffer>, while sharp's toBuffer() returns the wider
  // Buffer<ArrayBufferLike>, so an inferred type here rejects the
  // reassignment below.
  let buffer: Buffer = Buffer.from(generation.imageUrl, 'base64');

  // Defensive resize back to the source's own real dimensions - this
  // model has been directly observed not reliably hitting a requested
  // size even when explicitly told the target pixel dimensions.
  const sourceMeta = await sharp(await fetchBuffer(currentAssetUrl)).metadata();
  if (sourceMeta.width && sourceMeta.height) {
    buffer = await resizeToExactSize(buffer, { width: sourceMeta.width, height: sourceMeta.height });
  }

  return {
    imageBuffer: buffer,
    lane: 'pixel',
    reason: 'This target has no editable spec, so the whole canvas was re-rendered from the current asset.',
    costInr: generation.costInr,
  };
}
