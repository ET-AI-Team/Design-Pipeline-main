import axios, { type AxiosInstance, type AxiosError } from 'axios';

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = { maxRetries: 3, baseDelayMs: 400 };

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network error, no response at all
  return status === 429 || (status >= 500 && status < 600);
}

function jitteredDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates an Axios instance that automatically retries transient
 * technical failures (network errors, 429, 5xx) with exponential
 * backoff and jitter, per NFR §5. This retry is invisible to callers
 * and NEVER counts against the Orchestrator's content-quality attempt
 * limit - it resolves or rejects the original call transparently.
 */
export function createHttpClient(baseURL: string, retry: RetryConfig = DEFAULT_RETRY): AxiosInstance {
  const instance = axios.create({ baseURL, timeout: 60_000 });

  instance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const config = error.config as (typeof error.config & { __retryCount?: number }) | undefined;
      if (!config) throw error;

      config.__retryCount = config.__retryCount ?? 0;
      const status = error.response?.status;

      if (config.__retryCount >= retry.maxRetries || !isRetryableStatus(status)) {
        throw error;
      }

      config.__retryCount += 1;
      const delay = jitteredDelay(config.__retryCount, retry.baseDelayMs);
      await sleep(delay);
      return instance(config);
    }
  );

  return instance;
}
