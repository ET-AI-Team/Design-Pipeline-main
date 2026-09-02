import { planEditPatch, type EditLane, type EditPatch } from '../providers/openai.client';
import { clampStyle } from './render-poster';
import { sanitizeAdCopy, type AdCopy, type PosterStyleSpec } from '../providers/openai.client';

export interface EffectiveSpec {
  style: PosterStyleSpec;
  adCopy: AdCopy;
}

export interface PlannedEdit {
  lane: EditLane;
  reason: string;
  patch: EditPatch;
  /** The effective spec AFTER the patch was applied and validated -
   *  what actually gets rendered, and what the next edit starts from. */
  spec: EffectiveSpec;
  costInr: number;
  latencyMs: number;
}

/** Deep merge that only ever overwrites keys the patch actually names.
 *  Arrays are REPLACED, not merged element-wise: a patch that says
 *  headlineLines is ["A","B"] means exactly those two lines, and
 *  index-merging would produce a hybrid of old and new wording - the
 *  same class of old/new-text confusion mergeCopyWithPrevious was
 *  written to eliminate on the poster stage's own retries. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object' || typeof base !== 'object' || base === null || Array.isArray(base)) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/**
 * Turns a free-text "improve this" instruction into a STRUCTURED,
 * validated patch against the poster's current effective spec, rather
 * than handing prose to an image model and hoping.
 *
 * This is the same split every other AI decision in this pipeline uses
 * (classifyBaseLayer, generateAdCopy, detectLogoPosition): the model
 * decides *what* should change, code decides *whether that is legal* and
 * applies it exactly. A patch is no more trustworthy than any other model
 * output, so copy goes through the same sanitiser generateAdCopy uses and
 * style goes through clampStyle - the identical validation a freshly
 * extracted style gets.
 */
export async function planAssetEdit(params: {
  instruction: string;
  current: EffectiveSpec;
  /** True when the user attached reference images - the router should
   *  lean toward the pixel lane for "make it look like this", which no
   *  spec field can express. */
  hasUserReferences: boolean;
}): Promise<PlannedEdit> {
  const planned = await planEditPatch({
    instruction: params.instruction,
    currentCopy: params.current.adCopy,
    currentStyle: params.current.style,
    hasUserReferences: params.hasUserReferences,
  });

  // The pixel lane deliberately changes nothing in the spec - it is a
  // whole-canvas render of the CURRENT spec plus the raw instruction,
  // for asks no field can represent ("remove the car", "warmer photo").
  if (planned.lane === 'pixel') {
    return {
      lane: 'pixel',
      reason: planned.reason,
      patch: {},
      spec: params.current,
      costInr: planned.costInr,
      latencyMs: planned.latencyMs,
    };
  }

  const patchedCopy = planned.copyPatch
    ? sanitizeAdCopy(deepMerge(params.current.adCopy, planned.copyPatch))
    : params.current.adCopy;

  const patchedStyle = planned.stylePatch
    ? clampStyle(deepMerge(params.current.style, planned.stylePatch))
    : params.current.style;

  return {
    lane: planned.lane,
    reason: planned.reason,
    patch: { copyPatch: planned.copyPatch, stylePatch: planned.stylePatch },
    spec: { style: patchedStyle, adCopy: patchedCopy },
    costInr: planned.costInr,
    latencyMs: planned.latencyMs,
  };
}
