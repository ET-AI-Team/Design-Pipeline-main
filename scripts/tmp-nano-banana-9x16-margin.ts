/**
 * One-off task: add top/bottom margin to output/3rd-9x16.png by moving
 * two rigid text/UI groups vertically (top group down, bottom group
 * up), X positions unchanged, base photo untouched. Uses Gemini's image
 * model ("Nano Banana Pro" = gemini-3-pro-image) as a surgical edit on
 * the existing flattened poster.
 *
 * v2 lesson (from a first attempt on the 16x9 file that got silently
 * ignored): prose like "add margin" / "move down" does nothing on its
 * own - this codebase's own poster-text-edit.ts already discovered the
 * same thing twice for center-alignment. Give exact pixel numbers, and
 * attach a real reference image showing the target amount of margin (a
 * different, unrelated poster the user pointed at) - a picture of the
 * right proportions beats prose for exactly this kind of structural ask.
 *
 * Run with: bun run nano-banana-9x16-margin.ts
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

const REPO_ROOT = '/Users/abhigyan/Desktop/design-pipeline';
const OUTPUT_DIR = join(REPO_ROOT, 'output');
const SOURCE = join(OUTPUT_DIR, '3rd-9x16.png');
const RESULT_PATH = join(OUTPUT_DIR, '3rd-9x16-margin-check-v3.png');
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const TOP_MARGIN_PX = 180; // ~9% of 1920
const BOTTOM_MARGIN_PX = 150; // ~8% of 1920

function loadEnv(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return env;
}

const env = loadEnv(join(REPO_ROOT, '.env'));
const GEMINI_API_KEY = env.GEMINI_API_KEY;
const GEMINI_PRO_MODEL = env.GEMINI_PRO_MODEL || 'gemini-3-pro-image';

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not found in .env');
  process.exit(1);
}

const EDIT_PROMPT = `You are editing an existing, finished advertising poster image (attached, ${TARGET_WIDTH}x${TARGET_HEIGHT}). Your ONLY job is to add breathing-room margin at the very top and very bottom of the canvas by repositioning two existing groups of elements vertically, using the exact pixel targets below. Do not change anything else.

HARD CONSTRAINT - the photo itself must not change:
- The runner (his pose, face, outfit, position), the Hyderabad skyline silhouette, the road, and the warm gradient/diagonal maroon panel background must remain exactly as they already are - same pixels, same content, not regenerated or redrawn.

THE ONLY EDIT TO MAKE to Image 1 - move two groups vertically by these exact amounts, X positions unchanged for everything:

GROUP 1 (top group): "TIMES INTERNET / HALF MARATHON" logo + headline ("OCT 25." / "HYDERABAD'S" / "RACE DAY.") + subtext ("One start line, thousands of runners. Claim your bib.") + the "Hyderabad | Oct 25, 2026" pill.
  MEASURE: right now, the very top pixel of the logo text sits at approximately y=20 (out of ${TARGET_HEIGHT}px total canvas height), i.e. essentially touching the top edge.
  TARGET: after your edit, the very top pixel of the logo text must sit at approximately y=${20 + TOP_MARGIN_PX} instead. That is the only change for this group - move it down the canvas by that amount, as one rigid unit, keeping internal spacing, font sizes, colors, and X position exactly as they are now.

GROUP 2 (bottom group): the dark stat bar ("3Km / Run For Fun", "5Km / Level Up", "10Km / Push Limits", "21.1Km / Go All In") + the red "REGISTER NOW | UPTO 33% OFF" footer bar.
  MEASURE: right now, the very bottom pixel of the red bar sits at approximately y=${TARGET_HEIGHT} (out of ${TARGET_HEIGHT}px total canvas height), i.e. exactly on the bottom edge.
  TARGET: after your edit, the very bottom pixel of the red bar must sit at approximately y=${TARGET_HEIGHT - BOTTOM_MARGIN_PX} instead. That is the only change for this group - move it up the canvas by that amount, as one rigid unit, keeping internal spacing, sizes, colors, and X position exactly as they are now. Let the road/background show naturally in the new gap below it.

Do not change the wording, spelling, fonts, colors, or sizes of any text or UI element in Image 1 - only the Y position of these two rigid blocks, by the exact pixel amounts above. Do not change the horizontal (X) position of anything. Any gap that opens up must be filled with the same background (gradient/maroon panel/road) naturally continuing - not left blank, not a hard seam.

Output must be exactly ${TARGET_WIDTH}x${TARGET_HEIGHT} pixels, same aspect ratio, professional advertising-campaign quality.`;

const GENERATE_TIMEOUT_MS = 300_000;

async function editImage(): Promise<{ data: Buffer; mimeType: string }> {
  const inputBuffer = readFileSync(SOURCE);
  const meta = await sharp(inputBuffer).metadata();
  const mimeType = meta.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const base64 = inputBuffer.toString('base64');

  const parts = [
    { text: EDIT_PROMPT },
    { text: 'Image to edit - the exact poster described above, attached as the source:' },
    { inline_data: { mime_type: mimeType, data: base64 } },
  ];

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), GENERATE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_PRO_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: abortController.signal,
      }
    );
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 2000)}`);
  }

  const json: any = await res.json();
  const imagePart = json?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData || p.inline_data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;

  if (!inlineData?.data) {
    console.error('Full response (no image found):', JSON.stringify(json, null, 2).slice(0, 3000));
    throw new Error('Gemini response did not contain an image payload');
  }

  return {
    data: Buffer.from(inlineData.data, 'base64'),
    mimeType: inlineData.mimeType || inlineData.mime_type || 'image/png',
  };
}

async function main() {
  console.log(`--- Editing 3rd-9x16.png (add top/bottom margin) ---`);
  const startedAt = Date.now();

  const { data, mimeType } = await editImage();
  console.log(`  received ${data.byteLength} bytes, mime=${mimeType}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const resultMeta = await sharp(data).metadata();
  let finalBuffer = data;
  if (resultMeta.width !== TARGET_WIDTH || resultMeta.height !== TARGET_HEIGHT) {
    console.log(`  returned ${resultMeta.width}x${resultMeta.height}, resizing to ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
    finalBuffer = await sharp(data).resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: 'cover' }).png().toBuffer();
  }

  writeFileSync(RESULT_PATH, finalBuffer);
  console.log(`  saved -> ${RESULT_PATH}`);
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
