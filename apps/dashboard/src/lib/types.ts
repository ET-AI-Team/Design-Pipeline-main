import type { JobStatus } from '@pipeline/shared-types';

export interface StageAttempt {
  id: string;
  stage: string;
  attemptNumber: number;
  modelUsed: string;
  latencyMs: number;
  costInr: string;
  qaScore: string | null;
  qaReasoning: string | null;
  assetUrl: string | null;
  boundingBoxJson: { x: number; y: number; width: number; height: number } | null;
  result: 'PASS' | 'RETRY' | 'ESCALATED';
  startedAt: string;
  completedAt: string | null;
}

export interface DimensionJobRow {
  id: string;
  dimension: string;
  status: 'PENDING' | 'GENERATING' | 'SCORING' | 'DELIVERED' | 'NEEDS_ATTENTION';
  assetUrl: string | null;
}

export interface ApprovalLog {
  decision: 'approve' | 'reject';
  comment: string | null;
  decidedAt: string;
}

export interface JobDetail {
  id: string;
  name: string | null;
  status: JobStatus;
  reference1Url: string;
  reference2Url: string;
  logoUrl: string;
  prompt: string;
  baseAssetUrl: string | null;
  posterUrl: string | null;
  createdAt: string;
  updatedAt: string;
  stageAttempts: StageAttempt[];
  dimensionJobs: DimensionJobRow[];
  approvalLog: ApprovalLog | null;
  assetEdits?: AssetEditRow[];
  /** Dimension names whose asset predates the latest poster edit, so
   *  they were recomposed from a poster that no longer exists. Derived
   *  server-side on read, not stored. */
  staleDimensions?: string[];
}

export interface AssetEditRow {
  id: string;
  target: string;
  instruction: string;
  lane: string | null;
  resultAssetUrl: string | null;
  errorMessage: string | null;
  costInr: string | null;
  latencyMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface JobSummary {
  jobId: string;
  name: string | null;
  status: JobStatus;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

/** Fixed pipeline order - the API doesn't return an explicit order field,
 *  but the stage sequence is a known constant (stage-registry.ts's
 *  registration order). Logo position-detection and compositing are one
 *  folded stage now (see run-deterministic-stage.ts's logo_composite) -
 *  a QA failure after placement re-asks for a coordinate internally
 *  rather than as a separately-tracked stage, so there's one row here,
 *  not two. */
export const PIPELINE_STAGES = ['base_asset', 'logo_composite', 'poster'] as const;

export const STAGE_LABELS: Record<string, string> = {
  base_asset: 'Base asset generation',
  logo_composite: 'Logo placement',
  poster: 'Poster generation',
};

/** Which JobStatus values mean "this stage is currently in flight" -
 *  the reverse of the server's statusForStage() mapping, used to show a
 *  live spinner on the right step before any StageAttempt row exists
 *  for it yet. logo_composite spans two statuses (it emits
 *  LOGO_PLACEMENT_DETECTING transiently before settling into
 *  LOGO_COMPOSITING - see run-deterministic-stage.ts). */
export const STAGE_ACTIVE_STATUSES: Record<string, JobStatus[]> = {
  base_asset: ['BASE_ASSET_GENERATING', 'BASE_ASSET_SCORING'],
  logo_composite: ['LOGO_PLACEMENT_DETECTING', 'LOGO_COMPOSITING'],
  poster: ['POSTER_GENERATING', 'POSTER_SCORING'],
};

export type StepDisplayStatus = 'pending' | 'active' | 'done' | 'stuck';

export function stageDisplayStatus(
  stageName: string,
  attempts: StageAttempt[],
  jobStatus: JobStatus
): StepDisplayStatus {
  const last = attempts[attempts.length - 1];
  if (last?.result === 'PASS') return 'done';
  if (jobStatus === 'NEEDS_ATTENTION' && last?.result === 'ESCALATED') return 'stuck';
  if (attempts.length > 0) return 'active'; // mid content-quality-retry cycle
  if ((STAGE_ACTIVE_STATUSES[stageName] ?? []).includes(jobStatus)) return 'active';
  return 'pending';
}
