import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BoundingBoxImage } from '@/components/BoundingBoxImage';
import { cn } from '@/lib/utils';
import type { StageAttempt, StepDisplayStatus } from '@/lib/types';
import { Check, Loader2, Circle, AlertTriangle, RotateCw } from 'lucide-react';

const RESULT_VARIANT: Record<string, 'success' | 'warning' | 'attention'> = {
  PASS: 'success',
  RETRY: 'warning',
  ESCALATED: 'attention',
};

function StatusIcon({ status }: { status: StepDisplayStatus }) {
  if (status === 'done')
    return (
      <div className="bg-success flex size-[18px] shrink-0 items-center justify-center rounded-full">
        <Check className="size-[10px] stroke-[3] text-white" />
      </div>
    );
  if (status === 'active')
    return (
      <div className="bg-primary/15 text-primary flex size-[18px] shrink-0 items-center justify-center rounded-full">
        <Loader2 className="size-[11px] animate-spin" />
      </div>
    );
  if (status === 'stuck')
    return (
      <div className="bg-attention/15 text-attention flex size-[18px] shrink-0 items-center justify-center rounded-full">
        <AlertTriangle className="size-[10px]" />
      </div>
    );
  return (
    <div className="bg-muted text-muted-foreground flex size-[18px] shrink-0 items-center justify-center rounded-full">
      <Circle className="size-[7px] fill-current" />
    </div>
  );
}

interface Props {
  label: string;
  status: StepDisplayStatus;
  attempts: StageAttempt[];
  onRetry?: () => void;
  retrying?: boolean;
  onPreview?: (src: string) => void;
}

export function StageStep({ label, status, attempts, onRetry, retrying, onPreview }: Props) {
  return (
    <div className="flex gap-3.5 pb-[26px] last:pb-0">
      <div className="flex flex-none flex-col items-center">
        <StatusIcon status={status} />
        <div className="bg-border mt-1.5 w-px flex-1" />
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn('mb-2.5 text-[13.5px] font-semibold', status === 'pending' && 'text-muted-foreground')}>
          {label}
        </p>

        <div className="space-y-3">
          {attempts.map((a, i) => {
            // dispatchStageJob() writes a placeholder row (result: 'RETRY',
            // modelUsed: '', completedAt: null) the instant a stage is
            // queued, before the worker has actually run - showing that
            // placeholder's literal 'RETRY' value reads as "this attempt
            // already failed" rather than "this is in flight," exactly
            // backwards for a view whose whole point is being able to
            // trust what it shows at a glance.
            const isPending = a.completedAt === null;
            return (
              <div key={a.id} className={cn('flex items-start gap-3.5', i > 0 && 'border-border/70 border-t pt-3')}>
                {a.assetUrl && (
                  <button
                    type="button"
                    onClick={() => onPreview?.(a.assetUrl!)}
                    className="ring-border hover:ring-primary shrink-0 rounded-md ring-1 transition-all"
                    title="Open full-size image"
                  >
                    <BoundingBoxImage
                      src={a.assetUrl}
                      alt={label}
                      box={a.boundingBoxJson}
                      className="size-[60px] shrink-0"
                    />
                  </button>
                )}
                <div className="min-w-0 flex-1 space-y-[7px]">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                    <span className="text-muted-foreground">attempt {a.attemptNumber}</span>
                    {isPending ? (
                      <Badge variant="secondary">
                        <Loader2 className="animate-spin" /> in progress
                      </Badge>
                    ) : (
                      <Badge variant={RESULT_VARIANT[a.result] ?? 'secondary'}>{a.result}</Badge>
                    )}
                    {a.qaScore !== null && <span className="text-muted-foreground">QA {a.qaScore}/10</span>}
                  </div>
                  {a.qaReasoning && (
                    <p className="text-foreground/80 text-[13px] leading-[1.6]">{a.qaReasoning}</p>
                  )}
                  {!isPending && a.modelUsed && (
                    <span className="text-muted-foreground font-mono text-[10.5px]">
                      {a.modelUsed} · {a.latencyMs}ms · ₹{a.costInr}
                    </span>
                  )}
                  {!isPending && !a.modelUsed && !a.assetUrl && (
                    <p className="text-muted-foreground text-[11px]">Failed before reaching the provider</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {status === 'active' && attempts.length === 0 && (
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3 animate-spin" /> Starting…
          </p>
        )}

        {status === 'stuck' && onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying} className="mt-3">
            {retrying ? <Loader2 className="animate-spin" /> : <RotateCw />}
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
