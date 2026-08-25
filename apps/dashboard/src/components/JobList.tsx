import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { socket } from '@/lib/socket';
import { cn, relativeTime, unwrapJson } from '@/lib/utils';
import type { JobSummary } from '@/lib/types';
import { Plus, Inbox, ChevronLeft, ChevronRight, Trash2, Pencil, Check, X, AlertCircle } from 'lucide-react';

const FILTERS = ['ALL', 'NEEDS_ATTENTION', 'COMPLETE'] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<Filter, string> = {
  ALL: 'All',
  NEEDS_ATTENTION: 'Attention',
  COMPLETE: 'Complete',
};

const STATUS_DOT: Record<string, string> = {
  COMPLETE: 'bg-success',
  REJECTED: 'bg-destructive',
  NEEDS_ATTENTION: 'bg-attention',
  QUEUED: 'bg-muted-foreground',
  AWAITING_APPROVAL: 'bg-warning',
};
const STATUS_TEXT: Record<string, string> = {
  COMPLETE: 'text-success',
  REJECTED: 'text-destructive',
  NEEDS_ATTENTION: 'text-attention',
  QUEUED: 'text-muted-foreground',
  AWAITING_APPROVAL: 'text-warning',
};
const ACTIVE_DOT = 'bg-primary animate-pulse';
const ACTIVE_TEXT = 'text-primary';

interface Props {
  selectedJobId: string | null;
  onSelect: (jobId: string | null) => void;
}

export function JobList({ selectedJobId, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [collapsed, setCollapsed] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Every cached ['jobs', filter] variant (ALL/NEEDS_ATTENTION/COMPLETE)
  // needs the same patch applied in lockstep, since a job can be visible
  // under more than one filter's cached data at once.
  function patchJobsCache(updater: (jobs: JobSummary[]) => JobSummary[]) {
    queryClient.setQueriesData<JobSummary[]>({ queryKey: ['jobs'] }, (old) => (old ? updater(old) : old));
  }

  async function snapshotJobsCache() {
    await queryClient.cancelQueries({ queryKey: ['jobs'] });
    return queryClient.getQueriesData<JobSummary[]>({ queryKey: ['jobs'] });
  }

  function rollbackJobsCache(previous: [QueryKey, JobSummary[] | undefined][]) {
    for (const [key, data] of previous) queryClient.setQueryData(key, data);
  }

  const deleteMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const res = await fetch(`/api/v1/jobs/${jobId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('Delete failed - please try again.');
    },
    onMutate: async (jobId) => {
      setActionError(null);
      const previous = await snapshotJobsCache();
      patchJobsCache((jobs) => jobs.filter((j) => j.jobId !== jobId));
      return { previous };
    },
    onError: (err, _jobId, context) => {
      if (context) rollbackJobsCache(context.previous);
      setActionError(err instanceof Error ? err.message : 'Delete failed - please try again.');
    },
    onSuccess: (_data, jobId) => {
      if (jobId === selectedJobId) onSelect(null);
    },
    onSettled: () => {
      setConfirmDeleteId(null);
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ jobId, name }: { jobId: string; name: string }) => {
      const res = await fetch(`/api/v1/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('Rename failed - please try again.');
    },
    onMutate: async ({ jobId, name }) => {
      setActionError(null);
      const previous = await snapshotJobsCache();
      patchJobsCache((jobs) => jobs.map((j) => (j.jobId === jobId ? { ...j, name } : j)));
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context) rollbackJobsCache(context.previous);
      setActionError(err instanceof Error ? err.message : 'Rename failed - please try again.');
    },
    onSettled: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job'] });
    },
  });

  function commitRename(jobId: string, currentName: string | null) {
    const trimmed = editDraft.trim();
    if (!trimmed || trimmed === (currentName ?? '')) {
      setEditingId(null);
      return;
    }
    renameMutation.mutate({ jobId, name: trimmed });
  }

  const {
    data: jobs = [],
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['jobs', filter],
    queryFn: async (): Promise<JobSummary[]> => {
      const query = filter === 'ALL' ? '' : `?status=${filter}`;
      const res = await fetch(`/api/v1/jobs${query}`);
      const { jobs } = await unwrapJson<{ jobs: JobSummary[] }>(res);
      return jobs;
    },
    // Switching tabs (All/Attention/Complete) is a new queryKey each
    // time - without this, an uncached tab briefly flashes the "No jobs
    // yet" empty state before its data arrives.
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    // GET /jobs now returns `prompt` directly (fixed a real N+1: this
    // used to fetch every visible job's full detail just to show a
    // preview) - a socket event invalidating this one list query is all
    // that's needed to stay live, no more manual refetch plumbing.
    function invalidate() {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    }
    function syncAndJoin() {
      socket.emit('join:global');
      invalidate();
    }

    function handleDeleted(payload: { jobId: string }) {
      // Patch the row out immediately - waiting on the refetch for a
      // deletion that happened (possibly from another tab) reads as the
      // sidebar being behind, not just "a bit stale."
      patchJobsCache((jobs) => jobs.filter((j) => j.jobId !== payload.jobId));
      invalidate();
      if (payload.jobId === selectedJobId) onSelect(null);
    }

    // needs_attention/completed payloads carry just the jobId - patching
    // the status in place gives an instant sidebar update, then the
    // invalidate still runs to reconcile prompt/name/timestamps.
    function handleNeedsAttention(payload: { jobId: string }) {
      patchJobsCache((jobs) => jobs.map((j) => (j.jobId === payload.jobId ? { ...j, status: 'NEEDS_ATTENTION' } : j)));
      invalidate();
    }
    function handleCompleted(payload: { jobId: string }) {
      patchJobsCache((jobs) => jobs.map((j) => (j.jobId === payload.jobId ? { ...j, status: 'COMPLETE' } : j)));
      invalidate();
    }

    syncAndJoin();
    socket.on('connect', syncAndJoin);
    socket.on('feed:job_created', invalidate);
    socket.on('feed:job_deleted', handleDeleted);
    socket.on('job:needs_attention', handleNeedsAttention);
    socket.on('job:completed', handleCompleted);

    return () => {
      socket.off('connect', syncAndJoin);
      socket.off('feed:job_created', invalidate);
      socket.off('feed:job_deleted', handleDeleted);
      socket.off('job:needs_attention', handleNeedsAttention);
      socket.off('job:completed', handleCompleted);
    };
  }, [queryClient, selectedJobId, onSelect]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    // Auto-cancels the inline "confirm delete?" state after a few
    // seconds so a stray click elsewhere doesn't leave a row silently
    // armed to delete on the next click.
    const timer = setTimeout(() => setConfirmDeleteId(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 5000);
    return () => clearTimeout(timer);
  }, [actionError]);

  const isTerminal = (status: string) => ['COMPLETE', 'REJECTED', 'NEEDS_ATTENTION', 'QUEUED'].includes(status);

  if (collapsed) {
    return (
      <aside className="border-border flex w-[62px] shrink-0 flex-col items-center gap-3 border-r py-4 transition-[width] duration-[180ms] ease-out">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          className="border-border text-muted-foreground hover:bg-secondary flex size-[30px] items-center justify-center rounded-[7px] border bg-background transition-colors"
        >
          <ChevronRight className="size-3.5" />
        </button>
        <button
          onClick={() => onSelect(null)}
          title="New job"
          className="bg-primary text-primary-foreground hover:bg-primary/92 flex size-[30px] items-center justify-center rounded-[7px] transition-colors"
        >
          <Plus className="size-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="border-border flex w-[340px] shrink-0 flex-col overflow-hidden border-r transition-[width] duration-[180ms] ease-out">
      <div className="shrink-0 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSelect(null)}
            className="bg-primary text-primary-foreground hover:bg-primary/92 flex h-[38px] flex-1 items-center justify-center gap-[7px] rounded-lg text-[13px] font-semibold transition-colors"
          >
            <Plus className="size-3.5" /> New job
          </button>
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            className="border-border text-muted-foreground hover:bg-secondary flex size-[38px] shrink-0 items-center justify-center rounded-lg border bg-background transition-colors"
          >
            <ChevronLeft className="size-3.5" />
          </button>
        </div>
        <div className="border-border mt-[18px] flex gap-4 border-b">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'border-b-2 pb-2.5 text-[12.5px] font-semibold transition-colors',
                filter === f ? 'border-primary text-foreground' : 'text-muted-foreground border-transparent'
              )}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>
      {actionError && (
        <div className="text-destructive bg-destructive/5 mx-2 mb-2 flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px]">
          <AlertCircle className="size-3.5 shrink-0" />
          {actionError}
        </div>
      )}
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {isError && jobs.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm">
            <AlertCircle className="text-destructive size-6" />
            <span>{error instanceof Error ? error.message : 'Failed to load jobs.'}</span>
            <button
              onClick={() => refetch()}
              className="text-primary text-[12.5px] font-semibold hover:underline"
            >
              Retry
            </button>
          </div>
        )}
        {!isError && jobs.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm">
            <Inbox className="size-6 opacity-50" />
            No jobs yet.
          </div>
        )}
        {jobs.map((j) => {
          const active = j.jobId === selectedJobId;
          const confirming = confirmDeleteId === j.jobId;
          const editing = editingId === j.jobId;
          // Exactly one title line, always - a rename REPLACES what's
          // shown (like a real chat rename) rather than adding a second
          // line on top of the prompt preview that was always there.
          const title = j.name ?? j.prompt;
          return (
            <div
              key={j.jobId}
              role="button"
              tabIndex={0}
              onClick={() => !editing && onSelect(j.jobId)}
              onKeyDown={(e) => {
                if (!editing && (e.key === 'Enter' || e.key === ' ')) onSelect(j.jobId);
              }}
              className={cn(
                'group block w-full cursor-pointer rounded-xl px-3 py-3 text-left transition-colors',
                active ? 'bg-accent' : 'hover:bg-secondary/60'
              )}
            >
              <div className="mb-[5px] flex items-center gap-2">
                {editing ? (
                  <input
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(j.jobId, j.name)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') commitRename(j.jobId, j.name);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    maxLength={140}
                    placeholder="Name this job…"
                    className="border-primary/40 text-foreground min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-[13px] outline-none"
                  />
                ) : (
                  <span className="text-foreground/85 min-w-0 flex-1 truncate text-[13px] font-semibold">
                    {title}
                  </span>
                )}
                <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">
                  {relativeTime(j.createdAt)}
                </span>

                {confirming ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      title="Confirm delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteMutation.mutate(j.jobId);
                      }}
                      disabled={deleteMutation.isPending}
                      className="bg-destructive text-destructive-foreground flex size-5 items-center justify-center rounded-full disabled:opacity-50"
                    >
                      <Check className="size-3" />
                    </button>
                    <button
                      title="Cancel"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(null);
                      }}
                      className="border-border text-muted-foreground hover:bg-secondary flex size-5 items-center justify-center rounded-full border"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ) : !editing ? (
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      title="Rename job"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditDraft(j.name ?? '');
                        setEditingId(j.jobId);
                      }}
                      className="text-muted-foreground hover:bg-primary/10 hover:text-primary flex size-5 items-center justify-center rounded-full"
                    >
                      <Pencil className="size-3" />
                    </button>
                    <button
                      title="Delete job"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(j.jobId);
                      }}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex size-5 items-center justify-center rounded-full"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                ) : null}
              </div>
              <span
                className={cn(
                  'text-[11px] font-semibold capitalize',
                  isTerminal(j.status) ? (STATUS_TEXT[j.status] ?? 'text-muted-foreground') : ACTIVE_TEXT
                )}
              >
                <span
                  className={cn(
                    'mr-1.5 inline-block size-1.5 rounded-full align-middle',
                    isTerminal(j.status) ? (STATUS_DOT[j.status] ?? 'bg-muted-foreground') : ACTIVE_DOT
                  )}
                />
                {j.status.replace(/_/g, ' ').toLowerCase()}
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
