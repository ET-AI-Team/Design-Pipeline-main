import { createHttpClient } from '../lib/http-client';

const gemini = createHttpClient('https://generativelanguage.googleapis.com/v1beta');

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

export async function generateImage(params: GenerateImageParams): Promise<GenerateImageResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const startedAt = Date.now();

  const parts: unknown[] = [{ text: params.prompt }];
  for (const ref of params.referenceImages ?? []) {
    parts.push({ text: `Reference image - ${ref.role}` });
    parts.push({ file_data: { file_uri: ref.url } });
  }

  const response = await gemini.post(
    `/models/${params.model}:generateContent`,
    { contents: [{ parts }] },
    { params: { key: apiKey } }
  );

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
