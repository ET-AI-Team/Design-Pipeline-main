import { describe, it, expect } from 'bun:test';
import sharp from 'sharp';
import { enforceSquareCanvas } from './generate-and-score';

async function makePng(width: number, height: number): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3, 128);
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('enforceSquareCanvas', () => {
  it('real bug found live: center-crops a wide non-square image (base_asset generated 1408x768) down to a square', async () => {
    const wide = await makePng(1408, 768);
    const result = await enforceSquareCanvas(wide);
    const { width, height } = await sharp(result).metadata();
    expect(width).toBe(768);
    expect(height).toBe(768);
  });

  it('center-crops a tall non-square image down to a square', async () => {
    const tall = await makePng(600, 1000);
    const result = await enforceSquareCanvas(tall);
    const { width, height } = await sharp(result).metadata();
    expect(width).toBe(600);
    expect(height).toBe(600);
  });

  it('is a no-op when the image is already square', async () => {
    const square = await makePng(1024, 1024);
    const result = await enforceSquareCanvas(square);
    const { width, height } = await sharp(result).metadata();
    expect(width).toBe(1024);
    expect(height).toBe(1024);
  });

  it('crops from the center, not a corner', async () => {
    // Paint a distinct marker pixel at the exact center of a wide image,
    // and one at a corner - after cropping, the center marker must
    // survive and the corner marker must not.
    const width = 1000, height = 500;
    const buf = Buffer.alloc(width * height * 3, 0);
    const markCenter = (x: number, y: number, val: number) => {
      const i = (y * width + x) * 3;
      buf[i] = val;
    };
    markCenter(Math.floor(width / 2), Math.floor(height / 2), 255); // true center of the wide canvas
    markCenter(5, 5, 255); // near the far-left edge, outside where a center square crop would reach
    const wide = await sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();

    const result = await enforceSquareCanvas(wide);
    const { data, info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    const centerIdx = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    expect(data[centerIdx]).toBe(255);
    // The corner marker (near original x=5) should have been cropped away for a 1000x500 -> 500x500 center crop (left offset = 250).
    expect(data[0]).toBe(0);
  });
});
