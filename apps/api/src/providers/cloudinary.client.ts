import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export interface UploadResult {
  secureUrl: string;
  publicId: string;
}

/**
 * Uploads a buffer (from multer, or a base64-decoded generation result)
 * to Cloudinary under a per-job folder, so all assets for one job are
 * grouped and easy to locate during debugging or a manual audit.
 *
 * Uses a base64 data URI rather than upload_stream(): confirmed by
 * reproduction that upload_stream() under Bun silently mishandles the
 * signed multipart request once the buffer crosses ~2MB (Cloudinary
 * responds "Upload preset must be specified when using unsigned
 * upload" - its generic error for a request it received without a
 * usable signature, even though credentials are correctly configured).
 * Buffers under 2MB uploaded fine via streaming; every real pipeline
 * asset (photos, posters) routinely exceeds that, so this isn't an
 * edge case to special-case around - the whole function needed to
 * move off the streaming path.
 */
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_BASE_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function uploadToCloudinary(
  buffer: Buffer,
  options: { folder: string; publicId?: string }
): Promise<UploadResult> {
  const dataUri = `data:image/png;base64,${buffer.toString('base64')}`;

  // Real gap this closes: every OTHER outbound call in this codebase
  // retries transient failures automatically (lib/http-client.ts's
  // interceptor for Gemini/OpenAI, BullMQ's own `attempts: 3` for stage
  // jobs), but Cloudinary uploads go through the official SDK and so
  // bypassed all of it - a single transient blip on any upload failed
  // the whole stage outright. Same exponential-backoff-with-jitter shape
  // as http-client.ts, deliberately, rather than a second retry style.
  let lastError: unknown;
  for (let attempt = 0; attempt < UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await cloudinary.uploader.upload(dataUri, {
        folder: options.folder,
        public_id: options.publicId,
        resource_type: 'image',
      });
      return { secureUrl: result.secure_url, publicId: result.public_id };
    } catch (err) {
      lastError = err;
      if (attempt === UPLOAD_MAX_ATTEMPTS - 1) break;
      await sleep(UPLOAD_BASE_DELAY_MS * 2 ** attempt + Math.random() * UPLOAD_BASE_DELAY_MS);
    }
  }
  throw lastError;
}

/**
 * Recovers a Cloudinary public_id from one of our own secure URLs -
 * nothing in the DB stores public_id directly (only the URL), so
 * deleting a job's assets has to parse it back out rather than look it
 * up. Cloudinary URLs are shaped
 * `.../upload/v<version>/<folder>/<file>.<ext>` - the public_id is
 * everything between the version segment and the extension, folder
 * included. Returns null for anything that doesn't match (never throws
 * on a malformed/foreign URL - asset cleanup is best-effort, not a hard
 * requirement for the delete to succeed).
 */
export function extractPublicId(url: string): string | null {
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  return match?.[1] ?? null;
}

/**
 * Best-effort delete of one Cloudinary asset by its stored secure URL.
 * Throws on a real API failure (caller decides how to aggregate/log
 * across a whole job's worth of assets) but silently no-ops for a URL
 * whose public_id can't be recovered, rather than blocking deletion of
 * everything else.
 */
export async function deleteFromCloudinary(url: string): Promise<void> {
  const publicId = extractPublicId(url);
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
}
