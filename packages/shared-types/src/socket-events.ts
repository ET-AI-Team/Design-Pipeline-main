import type { JobStatus } from './enums';

export interface JobStatusChangedPayload {
  jobId: string;
  status: JobStatus;
  timestamp: string; // ISO 8601
}

export interface ApprovalRequestedPayload {
  jobId: string;
  posterUrl: string;
}

export interface ApprovalResponsePayload {
  jobId: string;
  decision: 'approve' | 'reject';
  /** Only meaningful on reject - why the human rejected it, for the
   *  record and to inform a future "regenerate with changes" follow-up. */
  comment?: string;
}

export interface NeedsAttentionPayload {
  jobId: string;
  stage: string;
  qaReasoning: string;
}

export interface JobCompletedPayload {
  jobId: string;
  dimensions: Array<{ dimension: string; assetUrl: string }>;
}

export interface JobCreatedPayload {
  jobId: string;
  createdAt: string;
}

export interface JobDeletedPayload {
  jobId: string;
}


export interface JoinJobPayload {
  jobId: string;
}

/** Events the server emits to clients. Per LLD §6.1: job:status_changed
 *  is per-job-room ONLY. The other three also reach the bounded global
 *  feed - that scoping is enforced in Phase 8.1, not here; this file is
 *  only the payload shape contract. */
export interface ServerToClientEvents {
  'job:status_changed': (payload: JobStatusChangedPayload) => void;
  'job:approval_requested': (payload: ApprovalRequestedPayload) => void;
  'job:needs_attention': (payload: NeedsAttentionPayload) => void;
  'job:completed': (payload: JobCompletedPayload) => void;
  'feed:job_created': (payload: JobCreatedPayload) => void;
  'feed:job_deleted': (payload: JobDeletedPayload) => void;
}

/** Events a client emits to the server. */
export interface ClientToServerEvents {
  'join:job': (payload: JoinJobPayload) => void;
  'join:global': () => void;
  'job:approval_response': (payload: ApprovalResponsePayload) => void;
}

export interface InterServerEvents {
  // Reserved for future multi-instance scaling (HLD §Scaling Posture);
  // empty in v1 since a single instance is sufficient (ADR-007).
}

export interface SocketData {
  // Reserved: no per-socket session data in v1 (ADR-013, no auth).
}
