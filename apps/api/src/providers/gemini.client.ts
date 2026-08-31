import { createHttpClient } from '../lib/http-client';

// Exported (not module-private) so tests can override `.defaults.adapter`
// to simulate a hung/never-resolving request, the same technique
// http-client.test.ts already uses to simulate 429/5xx responses -
// necessary to actually verify the timeout/AbortController wiring below
// fires, rather than just trusting it reads correctly.
export const gemini = createHttpClient('https://generativelanguage.googleapis.com/v1beta');

export interface ReferenceImage {
  url: string;
  /** What this image is and how the model should treat it (e.g. "this
   *  is the exact base photo, do not alter it" vs "this is a style
   *  reference - copy its layout conventions only, not its content").
   *  Injected as its own text part immediately before the image, since
   *  a bare image with no labeled role is exactly what let the model
   *  silently ignore a whole reference image in practice - confirmed
   *  live: the poster stage used to mention a reference's URL only as
   *  dead text in the prompt string, never attach it as an image at
   *  all, and the output showed zero influence from it. */
  role: string;
}

export interface GenerateImageParams {
  prompt: string;
  model: string; // e.g. process.env.GEMINI_FLASH_MODEL or GEMINI_PRO_MODEL
  referenceImages?: ReferenceImage[];
  /** Overrides GENERATE_TIMEOUT_MS below - production code never sets
   *  this (real generations legitimately take up to ~5min); exists so
   *  tests can simulate a hang without a real 300s wait. */
  timeoutMs?: number;
}

export interface GenerateImageResult {
  imageUrl: string; // base64 data URL or a hosted URL depending on API response shape
  latencyMs: number;
  costInr: number;
}

// Per-model pricing snapshot used to compute costInr locally, so cost
// tracking (HLD's monitoring fields) does not depend on the provider's
// own billing API being queried synchronously on every call.
const MODEL_COST_INR: Record<string, number> = {
  'gemini-3.1-flash-image': 5.8, // NFR §4 Scenario B baseline
  'gemini-3-pro-image': 11.7, // NFR §4 Scenario A baseline
};

// Real bug found live: axios's own `timeout` (createHttpClient's default
// 60s) does NOT reliably abort a call under Bun's http adapter - this
// pipeline already discovered the exact same failure mode once before,
// for openai.client.ts's editPosterImage(), where a real request hung
// indefinitely with zero error or retry logged despite the axios
// timeout supposedly being in effect. AbortController is a second,
// independent enforcement mechanism that doesn't depend on axios/Bun's
// internal socket-timeout wiring - kept alongside `timeout` (belt-and-
// suspenders) rather than replacing it, since which one actually fires
// first doesn't matter, only that ONE of them reliably does. Confirmed
// live: three separate base_asset generations hung forever with no
// resolve/reject and zero open connection to Gemini's API at the OS
// socket level (checked via lsof) - the network exchange had already
// finished, only the JS-level promise never settled.
//
// 300s, not editPosterImage's 120s: stalled-job-config.ts's own comment
// records real observed base_asset/poster latencies up to 286s (that's
// the exact reason lockDuration was set to 300s - "well past every
// observed real latency, with margin"). A 120s timeout here would abort
// genuinely slow-but-legitimate calls, not just hung ones, so this
// reuses that same already-vetted 300s figure rather than inventing a
// new number - it's an independent safety net from BullMQ's stalled
// detection (this catches "promise never settles despite the process
// being alive"; that catches "the worker process itself died"), so
// there's no requirement that one fire strictly before the other.
const GENERATE_TIMEOUT_MS = 300_000;

export async function generateImage(params: GenerateImageParams): Promise<GenerateImageResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const startedAt = Date.now();

  const parts: unknown[] = [{ text: params.prompt }];
  for (const ref of params.referenceImages ?? []) {
    parts.push({ text: `Reference image - ${ref.role}` });
    parts.push({ file_data: { file_uri: ref.url } });
  }

  const timeoutMs = params.timeoutMs ?? GENERATE_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  let response;
  try {
    response = await gemini.post(
      `/models/${params.model}:generateContent`,
      { contents: [{ parts }] },
      { params: { key: apiKey }, timeout: timeoutMs, signal: abortController.signal }
    );
  } finally {
    clearTimeout(timeoutHandle);
  }

  const latencyMs = Date.now() - startedAt;
  // The Gemini API's JSON response uses camelCase (inlineData, mimeType),
  // even though request fields are snake_case (file_data) - confirmed
  // against a real live call, not assumed from the request shape.
  const imageUrl: string | undefined = response.data?.candidates?.[0]?.content?.parts?.find(
    (p: any) => p.inlineData
  )?.inlineData?.data;

  if (!imageUrl) {
    throw new Error('Gemini response did not contain an image payload');
  }

  return {
    imageUrl,
    latencyMs,
    costInr: MODEL_COST_INR[params.model] ?? MODEL_COST_INR['gemini-3-pro-image']!,
  };
}
