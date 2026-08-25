/**
 * Disposable sanity check - not part of the application.
 * Not in the original readme.md plan: the Prerequisites section claims
 * sharp+Bun compatibility was "confirmed in Phase 0.1's sanity pass," but
 * no such check actually exists anywhere in the plan. sharp is load-
 * bearing for the one deterministic, no-AI stage in the pipeline (logo
 * compositing), so this proves the exact operation that stage performs -
 * resize a logo, composite it onto a base image at a bounding box,
 * encode to PNG - actually works under Bun before Phase 3 depends on it.
 * Run with: bun run scripts/sanity/sharp-bun-check.ts
 */
import sharp from 'sharp';

const BASE_WIDTH = 800;
const BASE_HEIGHT = 600;
const BOX = { x: 40, y: 40, width: 300, height: 100 };

async function main() {
  console.log('--- sharp + Bun sanity check ---');

  // Synthetic "base asset": a solid dark rectangle, standing in for a
  // generated photo, since this check must not depend on network access.
  const baseBuffer = await sharp({
    create: {
      width: BASE_WIDTH,
      height: BASE_HEIGHT,
      channels: 3,
      background: { r: 20, g: 30, b: 40 },
    },
  })
    .png()
    .toBuffer();

  // Synthetic "logo": a semi-transparent light rectangle, larger than the
  // target box, so the resize step is genuinely exercised.
  const logoBuffer = await sharp({
    create: {
      width: 600,
      height: 200,
      channels: 4,
      background: { r: 240, g: 240, b: 240, alpha: 0.9 },
    },
  })
    .png()
    .toBuffer();

  const resizedLogo = await sharp(logoBuffer).resize(BOX.width, BOX.height).toBuffer();

  const composited = await sharp(baseBuffer)
    .composite([{ input: resizedLogo, top: BOX.y, left: BOX.x }])
    .png()
    .toBuffer();

  const meta = await sharp(composited).metadata();

  if (meta.width !== BASE_WIDTH || meta.height !== BASE_HEIGHT || meta.format !== 'png') {
    console.error(`[FAIL] unexpected output metadata: ${JSON.stringify(meta)}`);
    process.exit(1);
  }

  console.log(
    `[PASS] composited a ${BOX.width}x${BOX.height} logo onto an ${BASE_WIDTH}x${BASE_HEIGHT} base, ` +
      `output is a valid ${meta.format} at ${meta.width}x${meta.height} (${composited.byteLength} bytes)`
  );
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
