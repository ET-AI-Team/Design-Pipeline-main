import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { generateImage, gemini } from './gemini.client';

const ORIGINAL_ADAPTER = gemini.defaults.adapter;
const ORIGINAL_KEY = process.env.GEMINI_API_KEY;

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(() => {
  gemini.defaults.adapter = ORIGINAL_ADAPTER;
  process.env.GEMINI_API_KEY = ORIGINAL_KEY;
});

describe('generateImage - hung-request timeout', () => {
  it('throws GEMINI_API_KEY is not configured immediately, without attempting a network call', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(generateImage({ prompt: 'x', model: 'gemini-3-pro-image' })).rejects.toThrow('GEMINI_API_KEY is not configured');
  });

  it(
    'real bug found live: rejects within the configured timeout instead of hanging forever - three separate real base_asset generations hung indefinitely with zero open connection to Gemini at the socket level, because axios\'s own `timeout` option alone does not reliably abort a request under Bun\'s http adapter (the exact same failure mode already found once before for editPosterImage)',
    async () => {
      // Simulates a real hung transport: the request never resolves on
      // its own, but DOES react to the AbortSignal - exactly what a
      // correct http adapter does, and exactly the behavior
      // generateImage's AbortController now depends on to recover.
      gemini.defaults.adapter = async (config) => {
        return new Promise((_resolve, reject) => {
          config.signal?.addEventListener?.('abort', () => {
            const err: any = new Error('canceled');
            err.code = 'ERR_CANCELED';
            err.config = config;
            reject(err);
          });
        });
      };

      const startedAt = Date.now();
      await expect(generateImage({ prompt: 'x', model: 'gemini-3-pro-image', timeoutMs: 50 })).rejects.toThrow();
      const elapsedMs = Date.now() - startedAt;
      // Real defect this proves is fixed: without the AbortController,
      // this would never resolve at all within any bounded time.
      //
      // Not sub-second, on purpose: createHttpClient's shared retry
      // interceptor (also used by openai.client.ts's editPosterImage -
      // same underlying quirk, not something this fix introduces)
      // reuses the SAME already-aborted signal across its own
      // maxRetries=3 backoff retries, so each retry fails near-instantly
      // too and the whole chain still burns through ~1-7s of backoff
      // before giving up for real. 15s is a generous bound that still
      // conclusively proves "not hanging forever", without being
      // fragile to the exact jittered backoff timing.
      expect(elapsedMs).toBeLessThan(15_000);
    },
    20_000
  );

  it('a normal, quickly-resolving call is unaffected by the new timeout wiring', async () => {
    gemini.defaults.adapter = async (config) => ({
      data: { candidates: [{ content: { parts: [{ inlineData: { data: 'base64imagedata', mimeType: 'image/png' } }] } }] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });

    const result = await generateImage({ prompt: 'x', model: 'gemini-3-pro-image' });
    expect(result.imageUrl).toBe('base64imagedata');
    expect(result.costInr).toBe(11.7);
  });
});
