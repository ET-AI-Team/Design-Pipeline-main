import sharp from 'sharp';
import type { JobStatus } from '@pipeline/shared-types';
import { generateImage, type ReferenceImage } from '../providers/gemini.client';
import { scoreImage, type VisionImageInput } from '../providers/openai.client';
import { uploadToCloudinary } from '../providers/cloudinary.client';
import { emitStatusChanged } from '../realtime/emitters';
import type { StageResult } from '../orchestrator/types';

interface GenerateAndScoreParams {
  jobId: string;
  prompt: string;
  model: string;
  referenceImages?: ReferenceImage[];
  cloudinaryFolder: string;
  /** Status pushed over the socket between generation and scoring, so
   *  the dashboard shows a real intermediate state (e.g. BASE_ASSET_SCORING)
   *  instead of jumping straight from generating to the next stage - see
   *  the note on why generate+score are bundled into one worker call. */
  scoringStatus: JobStatus;
  rubricPrompt: string;
  /** Real gap found live: scoreImage used to judge the candidate image
   *  completely blind, with no visual anchor to compare against - a
   *  distinctly-named/shaped field from `referenceImages` above (that
   *  one is Gemini-generation-shaped, with a `role` field, and drives a
   *  different call) so the two concerns stay clean. Optional - callers
   *  that don't pass it (dimension stages) are unaffected. */
  qaReferenceImages?: VisionImageInput[];
  /** Real defect found live: the prompt asks for "1:1 square" but there
   *  is no explicit aspect-ratio parameter on the Gemini call enforcing
   *  it, and it occasionally ignores the instruction outright (a real
   *  job generated 1408x768). Every square-canvas assumption downstream
   *  - the Layered Text-Composition Architecture's box geometry
   *  especially - depends on this actually being true, not just
   *  requested. Only ever set by base_asset - the three dimension_*
   *  stages legitimately generate non-square output and must never have
   *  this applied. */
  enforceSquare?: boolean;
}

/** Center-crops to a square if the generated image isn't already one -
 *  loses a little framing at the longer edge, but that's a far safer
 *  failure mode than silently shipping a non-square canvas through the
 *  rest of the pipeline (a crop never distorts the subject; a resize
 *  to square would). A no-op (returns the same buffer) when the image
 *  is already square. */
export async function enforceSquareCanvas(buffer: Buffer): Promise<Buffer> {
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height || width === height) return buffer;
  const size = Math.min(width, height);
  const left = Math.round((width - size) / 2);
  const top = Math.round((height - size) / 2);
  return sharp(buffer).extract({ left, top, width: size, height: size }).png().toBuffer();
}

/**
 * Thrown when generation+upload succeeded but the scoring call itself
 * failed (e.g. the vision provider's key/quota is broken). Carries the
 * already-paid-for asset URL so a caller catching this doesn't lose it -
 * see the note on ScoringFailedError below for why this exists.
 */
export class ScoringFailedError extends Error {
  constructor(
    message: string,
    public readonly assetUrl: string,
    public readonly generationCostInr: number
  ) {
    super(message);
    this.name = 'ScoringFailedError';
  }
}

/**
 * Shared by every stage that generates an image and then scores it
 * (base_asset, poster, all three dimension stages) - identical shape
 * each time: generate, persist to Cloudinary, tell the dashboard scoring
 * has started, then score. Written once here per the "no duplication"
 * convention rather than copy-pasted per stage.
 */
export async function generateAndScore(params: GenerateAndScoreParams): Promise<StageResult> {
  const startedAt = Date.now();

  const generation = await generateImage({
    prompt: params.prompt,
    model: params.model,
    referenceImages: params.referenceImages,
  });

  const rawBuffer = Buffer.from(generation.imageUrl, 'base64');
  const buffer = params.enforceSquare ? await enforceSquareCanvas(rawBuffer) : rawBuffer;
  const upload = await uploadToCloudinary(buffer, { folder: params.cloudinaryFolder });

  emitStatusChanged(params.jobId, params.scoringStatus);

  let scoring: Awaited<ReturnType<typeof scoreImage>>;
  try {
    scoring = await scoreImage({
      imageUrl: upload.secureUrl,
      rubricPrompt: params.rubricPrompt,
      referenceImages: params.qaReferenceImages,
    });
  } catch (err) {
    // Real gap found running this against a job while the vision
    // provider's key was broken: generation had already succeeded (real
    // spend, a real image sitting on Cloudinary) but the bare throw from
    // scoreImage() propagated all the way to BullMQ's failure handler
    // with nothing carrying the asset URL along - the generated image
    // was effectively thrown away and never visible anywhere, even
    // though it existed. Wrapping it here is what lets the technical-
    // failure path still show the real generated asset instead of just
    // an error message with no image.
    const message = err instanceof Error ? err.message : String(err);
    throw new ScoringFailedError(message, upload.secureUrl, generation.costInr);
  }

  return {
    assetUrl: upload.secureUrl,
    qaScore: scoring.qaScore,
    qaReasoning: scoring.qaReasoning,
    modelUsed: params.model,
    latencyMs: Date.now() - startedAt,
    costInr: generation.costInr + scoring.costInr,
  };
}
