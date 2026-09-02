import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { socket } from '@/lib/socket';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StageStep } from '@/components/StageStep';
import { BoundingBoxImage } from '@/components/BoundingBoxImage';
import { ImageLightbox } from '@/components/ImageLightbox';
import { ImproveAsset } from '@/components/ImproveAsset';
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  stageDisplayStatus,
  type JobDetail,
} from '@/lib/types';
import type { JobSummary } from '@/lib/types';
import { relativeTime, unwrapJson } from '@/lib/utils';
import type { JobStatus, EditTarget } from '@pipeline/shared-types';
import { AlertCircle, Check, X, Loader2, ArrowRight, IndianRupee, Pencil, Trash2, RefreshCw } from 'lucide-react';

const TERMINAL_VARIANT: Record<string, 'success' | 'attention' | 'secondary'> = {
  COMPLETE: 'success',
  REJECTED: 'attention',
  NEEDS_ATTENTION: 'attention',
};

interface Props {
  jobId: string;
  onNewJob: (jobId: string) => void;
  onDeleted: () => void;
}

async function urlToFile(url: string, filename: string): Promise<File> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type });
}

async function fetchJob(jobId: string): Promise<JobDetail> {
  const res = await fetch(`/api/v1/jobs/${jobId}`);
  return unwrapJson<JobDetail>(res);
}

export function JobTrace({ jobId, onNewJob, onDeleted }: Props) {
  const [followUp, setFollowUp] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [respondingDecision, setRespondingDecision] = useState<'approve' | 'reject' | null>(null);
  const respondingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  const {
    data: job,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => fetchJob(jobId),
    // Keeps the previously-viewed job on screen while the next one loads,
    // instead of blanking the whole pane to a spinner - clicking through
    // jobs in the sidebar is the primary workflow here, and every
    // not-yet-cached job was flashing a full blank "Loading…" replacing
    // the entire detail pane (header, thumbnails, trace, everything).
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    function invalidate() {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    }
    function syncAndJoin() {
      socket.emit('join:job', { jobId });
      invalidate();
    }

    syncAndJoin();
    socket.on('connect', syncAndJoin);

    function handleStatusChanged(payload: { jobId: string; status: JobStatus }) {
      if (payload.jobId !== jobId) return;
      // The socket payload is just {jobId, status} - not the new
      // stageAttempts/posterUrl that came with this transition - so a
      // full refetch is still needed for correctness. But patching the
      // status into the cache first means the badge/trace state updates
      // the instant the event arrives instead of waiting on that
      // refetch's round-trip too.
      queryClient.setQueryData<JobDetail>(['job', jobId], (old) => (old ? { ...old, status: payload.status } : old));
      if (payload.status !== 'AWAITING_APPROVAL') setRespondingDecision(null);
      invalidate();
    }
    socket.on('job:status_changed', handleStatusChanged);

    return () => {
      socket.off('connect', syncAndJoin);
      socket.off('job:status_changed', handleStatusChanged);
    };
  }, [jobId, queryClient]);

  const regenerateDimensionsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/jobs/${jobId}/dimensions/regenerate`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? 'Could not regenerate the dimensions - please try again.');
      }
    },
    onMutate: () => setMutationError(null),
    onError: (err) =>
      setMutationError(err instanceof Error ? err.message : 'Could not regenerate the dimensions - please try again.'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', jobId] }),
  });

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/jobs/${jobId}/retry`, { method: 'POST' });
      if (!res.ok) throw new Error('Retry failed - please try again.');
    },
    onMutate: () => setMutationError(null),
    onError: (err) => setMutationError(err instanceof Error ? err.message : 'Retry failed - please try again.'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', jobId] }),
  });

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/v1/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('Rename failed - please try again.');
    },
    onMutate: async (name) => {
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey: ['job', jobId] });
      const previousJob = queryClient.getQueryData<JobDetail>(['job', jobId]);
      const previousLists = queryClient.getQueriesData<JobSummary[]>({ queryKey: ['jobs'] });
      queryClient.setQueryData<JobDetail>(['job', jobId], (old) => (old ? { ...old, name } : old));
      queryClient.setQueriesData<JobSummary[]>({ queryKey: ['jobs'] }, (old) =>
        old?.map((j) => (j.jobId === jobId ? { ...j, name } : j))
      );
      return { previousJob, previousLists };
    },
    onError: (err, _name, context) => {
      if (context?.previousJob) queryClient.setQueryData(['job', jobId], context.previousJob);
      if (context?.previousLists) for (const [key, data] of context.previousLists) queryClient.setQueryData(key, data);
      setMutationError(err instanceof Error ? err.message : 'Rename failed - please try again.');
    },
    onSettled: () => {
      setEditingName(false);
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/jobs/${jobId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('Delete failed - please try again.');
    },
    onMutate: () => setMutationError(null),
    onError: (err) => setMutationError(err instanceof Error ? err.message : 'Delete failed - please try again.'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      onDeleted();
    },
  });

  function commitRename() {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setEditingName(false);
      return;
    }
    if (trimmed === (job?.name ?? '')) {
      setEditingName(false);
      return;
    }
    renameMutation.mutate(trimmed);
  }

  useEffect(() => {
    // Switching jobs (clicking another sidebar row) shouldn't carry over
    // an armed "confirm delete?", an in-progress rename, a stale error,
    // or an approve/reject still "pending" from whatever job was open
    // before.
    setConfirmDelete(false);
    setEditingName(false);
    setMutationError(null);
    setRespondingDecision(null);
  }, [jobId]);

  useEffect(() => {
    return () => {
      if (respondingTimeoutRef.current) clearTimeout(respondingTimeoutRef.current);
    };
  }, []);

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      if (!job) throw new Error('Job not loaded');
      const [ref1, ref2, logo] = await Promise.all([
        urlToFile(job.reference1Url, 'reference1'),
        urlToFile(job.reference2Url, 'reference2'),
        urlToFile(job.logoUrl, 'logo'),
      ]);
      const formData = new FormData();
      formData.append('prompt', `${job.prompt}\n\nAdditional instructions: ${followUp}`);
      formData.append('reference1', ref1);
      formData.append('reference2', ref2);
      formData.append('logo', logo);
      const res = await fetch('/api/v1/jobs', { method: 'POST', body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? 'Submission failed');
      return body.data.jobId as string;
    },
    onMutate: () => setMutationError(null),
    onError: (err) => setMutationError(err instanceof Error ? err.message : 'Regenerate failed - please try again.'),
    onSuccess: (newJobId) => {
      setFollowUp('');
      onNewJob(newJobId);
    },
  });

  if (isError && !job) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 p-6 text-sm">
        <AlertCircle className="text-destructive size-5" />
        <span>{error instanceof Error ? error.message : 'Failed to load job.'}</span>
        <button onClick={() => refetch()} className="text-primary text-[12.5px] font-semibold hover:underline">
          Retry
        </button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
        <Loader2 className="animate-spin" /> Loading…
      </div>
    );
  }

  // socket.emit has no ack from this server, so there's no promise to
  // await here - respondingDecision is cleared by handleStatusChanged
  // once the job actually leaves AWAITING_APPROVAL, with this timeout as
  // a fallback so a dropped event can't leave the buttons stuck forever.
  function respond(decision: 'approve' | 'reject', comment?: string) {
    setRespondingDecision(decision);
    socket.emit('job:approval_response', { jobId, decision, comment });
    if (respondingTimeoutRef.current) clearTimeout(respondingTimeoutRef.current);
    respondingTimeoutRef.current = setTimeout(() => setRespondingDecision(null), 15_000);
  }

  function approve() {
    respond('approve');
  }

  function confirmReject() {
    respond('reject', rejectComment.trim() || undefined);
    setShowRejectForm(false);
    setRejectComment('');
  }

  const attemptsByStage = (stage: string) => job.stageAttempts.filter((a) => a.stage === stage);
  const dimensionAttempts = (dimension: string) =>
    job.stageAttempts.filter((a) => a.stage === `dimension_${dimension}`);
  const totalCost = job.stageAttempts.reduce((sum, a) => sum + Number.parseFloat(a.costInr || '0'), 0);

  return (
    <div className="mx-auto max-w-[780px] px-10 pt-12 pb-20">
      {/* What was submitted */}
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditingName(false);
              }}
              maxLength={140}
              className="border-primary/40 text-foreground w-full max-w-[360px] rounded border bg-transparent px-1.5 py-0.5 font-mono text-[13px] outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setNameDraft(job.name ?? '');
                setEditingName(true);
              }}
              title="Rename job"
              className="group/rename flex min-w-0 items-center gap-1.5"
            >
              <span className="text-foreground/80 truncate font-mono text-[13px]">
                {job.name ?? job.id.slice(0, 8)}
              </span>
              <Pencil className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover/rename:opacity-100" />
            </button>
          )}
          {isFetching && <Loader2 className="text-muted-foreground size-3 shrink-0 animate-spin" />}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {totalCost > 0 && (
            <span className="text-muted-foreground flex items-center gap-0.5 text-[12.5px]" title="Total spend so far">
              <IndianRupee className="size-3" />
              {totalCost.toFixed(2)}
            </span>
          )}
          <span className="text-muted-foreground text-[12.5px]">{relativeTime(job.createdAt)}</span>
          {confirmDelete ? (
            <span className="flex items-center gap-1.5">
              <span className="text-destructive text-[12px] font-medium">Delete job?</span>
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                title="Confirm delete"
                className="bg-destructive text-destructive-foreground flex size-5 items-center justify-center rounded-full disabled:opacity-50"
              >
                <Check className="size-3" />
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                title="Cancel"
                className="border-border text-muted-foreground hover:bg-secondary flex size-5 items-center justify-center rounded-full border"
              >
                <X className="size-3" />
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title="Delete job"
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {mutationError && (
        <div className="text-destructive bg-destructive/5 mb-3.5 flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12.5px]">
          <AlertCircle className="size-3.5 shrink-0" />
          {mutationError}
        </div>
      )}
      <p className="text-foreground/90 mb-[18px] text-[14.5px] leading-[1.65]">{job.prompt}</p>
      <div className="mb-9 flex gap-2">
        {[
          { src: job.reference1Url, alt: 'Reference 1' },
          { src: job.reference2Url, alt: 'Reference 2' },
          { src: job.logoUrl, alt: 'Logo' },
        ].map((img) =>
          // Empty for the few seconds between job creation and the
          // reference uploads landing (the API returns a jobId
          // immediately now and uploads in the background - see
          // finalize-job-creation.ts). Render the placeholder rather
          // than a broken <img> during that window.
          img.src ? (
            <button
              key={img.alt}
              type="button"
              onClick={() => setPreviewSrc(img.src)}
              className="bg-muted border-border hover:ring-primary flex size-16 items-center justify-center rounded-[7px] border p-1 transition-shadow hover:ring-2"
              title={img.alt}
            >
              <img src={img.src} alt={img.alt} className="max-h-full max-w-full object-contain" />
            </button>
          ) : (
            <div
              key={img.alt}
              title={`${img.alt} (uploading…)`}
              className="bg-muted border-border text-muted-foreground flex size-16 items-center justify-center rounded-[7px] border"
            >
              <Loader2 className="size-4 animate-spin" />
            </div>
          )
        )}
      </div>

      {/* Live trace */}
      <div className="mb-[22px] flex items-center justify-between">
        <span className="text-[15px] font-bold tracking-tight">Pipeline trace</span>
        <Badge variant={TERMINAL_VARIANT[job.status] ?? 'secondary'}>{job.status.replace(/_/g, ' ')}</Badge>
      </div>

      {PIPELINE_STAGES.map((stage) => {
        const attempts = attemptsByStage(stage);
        const status = stageDisplayStatus(stage, attempts, job.status);
        return (
          <StageStep
            key={stage}
            label={STAGE_LABELS[stage]!}
            status={status}
            attempts={attempts}
            onRetry={status === 'stuck' ? () => retryMutation.mutate() : undefined}
            retrying={retryMutation.isPending}
            onPreview={setPreviewSrc}
          />
        );
      })}

      {job.status === 'AWAITING_APPROVAL' && job.posterUrl && (
        <div className="border-border mt-1.5 rounded-[10px] border p-[22px]">
          <p className="mb-4 text-[13.5px] font-bold">Awaiting your approval</p>
          <button
            type="button"
            onClick={() => setPreviewSrc(job.posterUrl)}
            className="border-border mb-4 block w-full cursor-zoom-in overflow-hidden rounded-lg border"
          >
            <img src={job.posterUrl} alt="Poster" className="w-full" />
          </button>

          <div className="mb-4">
            <ImproveAsset jobId={jobId} target="poster" label="poster" />
          </div>

          {!showRejectForm ? (
            <div className="flex gap-2.5">
              <Button onClick={approve} disabled={respondingDecision !== null}>
                {respondingDecision === 'approve' ? <Loader2 className="animate-spin" /> : <Check />} Approve
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowRejectForm(true)}
                disabled={respondingDecision !== null}
                className="border-destructive/40 text-destructive hover:bg-destructive/5 hover:border-destructive/40"
              >
                <X /> Reject
              </Button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <Textarea
                value={rejectComment}
                onChange={(e) => setRejectComment(e.target.value)}
                placeholder="Why is this being rejected? (optional)"
                rows={2}
                autoFocus
              />
              <div className="flex gap-2.5">
                <Button
                  onClick={confirmReject}
                  disabled={respondingDecision !== null}
                  className="border-destructive/40 text-destructive hover:bg-destructive/5"
                  variant="outline"
                >
                  {respondingDecision === 'reject' ? <Loader2 className="animate-spin" /> : <X />} Confirm reject
                </Button>
                <Button variant="ghost" onClick={() => setShowRejectForm(false)} disabled={respondingDecision !== null}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {job.status === 'REJECTED' && job.approvalLog?.comment && (
        <div className="border-attention/30 mt-1.5 flex items-start gap-3 rounded-[10px] border p-[18px_20px]">
          <span className="bg-attention text-attention-foreground flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold">
            ✕
          </span>
          <div>
            <p className="text-attention text-[13.5px] font-bold">Rejection reason</p>
            <p className="text-foreground/85 mt-0.5 text-[12.5px]">{job.approvalLog.comment}</p>
          </div>
        </div>
      )}

      {/* Dimensions */}
      {job.dimensionJobs.length > 0 && (
        <div className="border-border mt-9 border-t pt-7">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-[13.5px] font-bold">Dimensions</p>
            {(job.staleDimensions?.length ?? 0) > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => regenerateDimensionsMutation.mutate()}
                disabled={regenerateDimensionsMutation.isPending}
                className="border-attention/40 text-attention hover:bg-attention/5"
              >
                {regenerateDimensionsMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Regenerate all 3
              </Button>
            )}
          </div>
          {(job.staleDimensions?.length ?? 0) > 0 && (
            <p className="text-attention mb-4 flex items-start gap-1.5 text-[12px]">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              These were recomposed from an earlier version of the poster and no longer match the edited one.
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {job.dimensionJobs.map((d) => {
              const attempts = dimensionAttempts(d.dimension);
              return (
                <div key={d.id} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium">{d.dimension}</span>
                    <Badge variant={TERMINAL_VARIANT[d.status] ?? 'secondary'}>{d.status}</Badge>
                  </div>
                  {d.assetUrl ? (
                    <button
                      type="button"
                      onClick={() => setPreviewSrc(d.assetUrl)}
                      className="hover:ring-primary block w-full rounded-md transition-shadow hover:ring-2"
                    >
                      <BoundingBoxImage src={d.assetUrl} alt={d.dimension} className="aspect-square w-full" />
                    </button>
                  ) : (
                    <div className="bg-muted border-border flex aspect-square w-full items-center justify-center rounded-md border">
                      <Loader2 className="text-muted-foreground animate-spin" />
                    </div>
                  )}
                  {attempts.map((a) => (
                    <p key={a.id} className="text-muted-foreground text-[11px]">
                      attempt {a.attemptNumber}: {a.result} {a.qaScore !== null && `(QA ${a.qaScore}/10)`}
                    </p>
                  ))}
                  {d.assetUrl && (
                    <ImproveAsset jobId={jobId} target={d.dimension as EditTarget} label={d.dimension} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Follow-up / regenerate - fires a brand new job under the hood,
          reusing this job's reference images plus the amended prompt.
          Not live-steering an in-flight job - there's no backend
          endpoint that accepts new prompt text for an existing job. */}
      <div className="border-border mt-8 border-t pt-7">
        <p className="mb-1.5 text-[13.5px] font-bold">Regenerate with changes</p>
        <p className="text-muted-foreground mb-3.5 text-[12.5px]">
          Starts a new job reusing the same reference images, with your note appended to the original prompt.
        </p>
        <Textarea
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          placeholder="e.g. make the headline bigger, use a warmer tone..."
          rows={2}
          className="min-h-16"
        />
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            onClick={() => regenerateMutation.mutate()}
            disabled={regenerateMutation.isPending || followUp.trim().length === 0}
          >
            {regenerateMutation.isPending && <Loader2 className="animate-spin" />}
            Regenerate
            {!regenerateMutation.isPending && <ArrowRight />}
          </Button>
        </div>
      </div>

      <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
