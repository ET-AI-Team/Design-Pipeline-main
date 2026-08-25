export const JobStatus = {
  QUEUED: 'QUEUED',
  BASE_LAYER_CLASSIFYING: 'BASE_LAYER_CLASSIFYING',
  BASE_ASSET_GENERATING: 'BASE_ASSET_GENERATING',
  BASE_ASSET_SCORING: 'BASE_ASSET_SCORING',
  LOGO_PLACEMENT_DETECTING: 'LOGO_PLACEMENT_DETECTING',
  LOGO_COMPOSITING: 'LOGO_COMPOSITING',
  POSTER_GENERATING: 'POSTER_GENERATING',
  POSTER_SCORING: 'POSTER_SCORING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  DIMENSION_EXPANDING: 'DIMENSION_EXPANDING',
  COMPLETE: 'COMPLETE',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
  REJECTED: 'REJECTED',
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const StageAttemptResult = {
  PASS: 'PASS',
  RETRY: 'RETRY',
  ESCALATED: 'ESCALATED',
} as const;
export type StageAttemptResult = (typeof StageAttemptResult)[keyof typeof StageAttemptResult];

export const DimensionStatus = {
  PENDING: 'PENDING',
  GENERATING: 'GENERATING',
  SCORING: 'SCORING',
  DELIVERED: 'DELIVERED',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
} as const;
export type DimensionStatus = (typeof DimensionStatus)[keyof typeof DimensionStatus];

/** The three dimensions expanded after approval, per LLD §5.1. Defined once, reused everywhere a loop over dimensions is needed. */
export const DIMENSION_NAMES = ['9x16', '4x5', '1.91x1'] as const;
export type DimensionName = (typeof DIMENSION_NAMES)[number];
