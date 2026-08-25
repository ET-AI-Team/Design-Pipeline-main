import { describe, it, expect } from 'bun:test';
import { createHttpClient } from './http-client';

describe('createHttpClient retry behavior', () => {
  it('retries on a 429 and eventually succeeds', async () => {
    let callCount = 0;
    const client = createHttpClient('http://test.local', { maxRetries: 3, baseDelayMs: 10 });

    // Intercept at the adapter level to simulate server responses
    // without a real network call.
    client.defaults.adapter = async (config) => {
      callCount += 1;
      if (callCount < 3) {
        const err: any = new Error('Too Many Requests');
        err.response = { status: 429, data: {}, headers: {}, config, statusText: '' };
        err.config = config;
        err.isAxiosError = true;
        throw err;
      }
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
    };

    const response = await client.get('/anything');
    expect(response.data.ok).toBe(true);
    expect(callCount).toBe(3);
  });

  it('gives up after maxRetries and throws', async () => {
    let callCount = 0;
    const client = createHttpClient('http://test.local', { maxRetries: 2, baseDelayMs: 5 });

    client.defaults.adapter = async (config) => {
      callCount += 1;
      const err: any = new Error('Internal Server Error');
      err.response = { status: 500, data: {}, headers: {}, config, statusText: '' };
      err.config = config;
      err.isAxiosError = true;
      throw err;
    };

    await expect(client.get('/anything')).rejects.toThrow();
    expect(callCount).toBe(3); // 1 original + 2 retries
  });
});
