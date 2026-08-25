// Real geometry that can be gotten catastrophically wrong (an arbitrary
// pixel size) stays deterministic - the model is never asked to size
// the logo, only to place an already-correctly-sized one. WHERE it goes
// is the model's call, made with the real photo plus every one of these
// numbers handed to it explicitly, not a bucketed guess corrected
// afterward by a separate heuristic. See run-deterministic-stage.ts's
// logo_composite branch, which folds the position decision and the
// actual placement into one retryable unit - re-placing at the exact
// same AI-chosen coordinate on a retry would fail identically every
// time, so the decision and the execution have to retry together.
const LOGO_WIDTH_RATIO = 0.22; // logo width as a fraction of canvas width
const LOGO_MAX_HEIGHT_RATIO = 0.11; // hard cap on height as a fraction of canvas height
const LOGO_MARGIN_X_HINT_RATIO = 0.045; // a starting suggestion only - the model judges the real number for this photo
const LOGO_TOP_AREA_MAX_RATIO = 0.15; // the logo's top edge must stay within this fraction of canvas height

export interface LogoDimensions {
  width: number;
  height: number;
}

export interface LogoBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Computes the logo's placed SIZE, aspect-ratio-preserving (never
 *  distorted), falling back to a height-driven size if the width-driven
 *  one would exceed LOGO_MAX_HEIGHT_RATIO (e.g. a near-square or
 *  vertical logo). Position is a separate decision - see
 *  detectLogoPosition in openai.client.ts. */
export function computeLogoDimensions(
  canvasW: number,
  canvasH: number,
  logoNaturalW: number,
  logoNaturalH: number
): LogoDimensions {
  let width = Math.round(canvasW * LOGO_WIDTH_RATIO);
  let height = Math.round(width * (logoNaturalH / logoNaturalW));

  const maxHeight = Math.round(canvasH * LOGO_MAX_HEIGHT_RATIO);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * (logoNaturalW / logoNaturalH));
  }
  return { width, height };
}

/** The margin hint and top-area constraint handed to the vision call as
 *  explicit numbers, computed once so both the request and the
 *  validation below agree on the same values. */
export function logoPlacementConstraints(canvasW: number, canvasH: number): { marginXHint: number; topAreaMaxY: number } {
  return {
    marginXHint: Math.round(canvasW * LOGO_MARGIN_X_HINT_RATIO),
    topAreaMaxY: Math.round(canvasH * LOGO_TOP_AREA_MAX_RATIO),
  };
}

/** The AI's returned coordinate is never trusted blind - clamped into
 *  the real valid range for this exact canvas/logo size, same "never
 *  trust an AI number for real geometry without checking it" principle
 *  used everywhere else in this pipeline. Clamped, not rejected: a
 *  coordinate a few pixels past a bound (or a non-finite value) is
 *  handled by clamping rather than burning a content-quality retry
 *  over it. */
export function clampLogoPosition(
  x: number,
  y: number,
  dims: LogoDimensions,
  canvasW: number,
  canvasH: number
): LogoBox {
  const maxX = Math.max(0, canvasW - dims.width);
  const maxY = Math.round(canvasH * LOGO_TOP_AREA_MAX_RATIO);
  const clampedX = Number.isFinite(x) ? Math.min(maxX, Math.max(0, Math.round(x))) : 0;
  const clampedY = Number.isFinite(y) ? Math.min(maxY, Math.max(0, Math.round(y))) : 0;
  return { x: clampedX, y: clampedY, width: dims.width, height: dims.height };
}
