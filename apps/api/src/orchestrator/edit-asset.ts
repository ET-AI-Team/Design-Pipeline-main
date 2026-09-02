import sharp from 'sharp';
import { db } from '../lib/db';
import { ApiError } from '../lib/api-error';
import { requireEnv } from '../lib/env';
import { generateImage } from '../providers/gemini.client';
import { resizeToExactSize } from '../stages/generate-and-score';
import { uploadToCloudinary } from '../providers/cloudinary.client';
import { Semaphore } from '../lib/semaphore';
import type { EditTarget } from '@pipeline/shared-types';

/** Caps concurrent Gemini calls from this endpoint specifically - unlike
 *  every other generation path in this pipeline, /edit has no BullMQ
 *  queue gating it, so without this a burst of simultaneous callers would
 *  fire an equally large burst of simultaneous provider calls. */
const editSemaphore = new Semaphore(Number(process.env.EDIT_CONCURRENCY ?? 8));

/**
 * Plain "improve this" edit: hits Nano Banana Pro (gemini-3-pro-image)
 * directly with the user's free-text instruction against whichever
 * asset is currently set for `target` (the 1:1 poster, or one specific
 * dimension). Deliberately outside the automated PASS/RETRY/ESCALATE
 * pipeline - no QA rubric, no retry cap, no StageAttempt row - the
 * human reading the result IS the QA. The new image REPLACES the old
 * one outright (Job.posterUrl or the matching DimensionJob.assetUrl is
 * overwritten); the previous asset is not retained.
 *
 * Synchronous by request - simplest thing that works. A real Gemini
 * call here can take up to ~90s (same latency profile already observed
 * for base_asset/dimension generation elsewhere in this codebase), so
 * the caller must be prepared for a slow response; there is no queue/
 * socket-event indirection for this endpoint.
 */
export async function editAsset(params: {
  jobId: string;
  target: EditTarget;
  instruction: string;
  /** Optional extra visual reference the user attached alongside the
   *  instruction (e.g. "make the CTA look like this") - a concrete image
   *  transfers a specific visual target far more reliably than prose
   *  alone, the same reasoning poster-text-edit.ts's reference-element
   *  crops already rely on for the automated pipeline. */
  referenceImageBuffer?: Buffer;
}): Promise<{ assetUrl: string }> {
  const job = await db.job.findFirst({
    where: { id: params.jobId, deletedAt: null },
    include: { dimensionJobs: true },
  });
  if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `No job with id ${params.jobId}`);

  const dimensionJob = params.target === 'poster' ? undefined : job.dimensionJobs.find((d) => d.dimension === params.target);
  const sourceAssetUrl = params.target === 'poster' ? job.posterUrl : dimensionJob?.assetUrl;

  if (!sourceAssetUrl) {
    throw new ApiError('VALIDATION_ERROR', 400, `No ${params.target} asset exists yet for this job to edit`, {
      field: 'target',
    });
  }

  // Validation above runs unqueued (cheap, no reason to make a caller
  // with a bad request wait behind slow in-flight edits) - only the real
  // provider-call work below is gated by the concurrency cap.
  return editSemaphore.run(() => performEdit(job.id, sourceAssetUrl, dimensionJob, params));
}

async function performEdit(
  jobId: string,
  sourceAssetUrl: string,
  dimensionJob: { id: string } | undefined,
  params: { target: EditTarget; instruction: string; referenceImageBuffer?: Buffer }
): Promise<{ assetUrl: string }> {
  // Uploaded first (if attached) so its real hosted URL exists before the
  // generateImage() call below - every reference image in this codebase
  // is attached by URL, never inline, and this is no exception.
  const referenceImageUrl = params.referenceImageBuffer
    ? (await uploadToCloudinary(params.referenceImageBuffer, { folder: `jobs/${jobId}/edits/references` })).secureUrl
    : undefined;

  const prompt = `You are making a targeted edit to this exact finished ad creative, based on the request below. Preserve everything the request doesn't ask you to change - do not alter any other text, wording, or layout element. Keep the same canvas dimensions and aspect ratio.

Requested change: "${params.instruction}"
${referenceImageUrl ? '\nAn additional reference image is attached below the current asset - use it as the concrete visual target for this change (e.g. matching a color, shape, or style it shows), not as something to copy wholesale into the design.\n' : ''}
Apply exactly this change, as precisely and naturally as possible, while keeping everything else faithful to the original.`;

  const generation = await generateImage({
    prompt,
    model: requireEnv('GEMINI_PRO_MODEL'),
    referenceImages: [
      {
        url: sourceAssetUrl,
        role: 'The exact current version of this asset - edit it directly per the instructions above, preserving everything not explicitly asked to change.',
      },
      ...(referenceImageUrl
        ? [
            {
              url: referenceImageUrl,
              role: 'An additional reference image supplied by the user for this edit - reflect its style, content, or detail as described in the instruction above. This is a style/content reference only, NOT the image being edited.',
            },
          ]
        : []),
    ],
  });

  let buffer: Buffer = Buffer.concat([Buffer.from(generation.imageUrl, 'base64')]);

  // Defensive resize back to the source's own real dimensions - this
  // model has been directly observed (this session, testing dimension
  // recomposition) not reliably hitting a requested size even when
  // explicitly told the target pixel dimensions.
  const sourceResponse = await fetch(sourceAssetUrl);
  const sourceBuffer = Buffer.from(new Uint8Array(await sourceResponse.arrayBuffer()));
  const sourceMeta = await sharp(sourceBuffer).metadata();
  if (sourceMeta.width && sourceMeta.height) {
    buffer = await resizeToExactSize(buffer, { width: sourceMeta.width, height: sourceMeta.height });
  }

  const upload = await uploadToCloudinary(buffer, { folder: `jobs/${jobId}/edits` });

  if (params.target === 'poster') {
    await db.job.update({ where: { id: jobId }, data: { posterUrl: upload.secureUrl } });
  } else if (dimensionJob) {
    await db.dimensionJob.update({ where: { id: dimensionJob.id }, data: { assetUrl: upload.secureUrl } });
  }

  return { assetUrl: upload.secureUrl };
}
