import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Wand2, X, ImagePlus, AlertTriangle, Check } from 'lucide-react';
import type { EditTarget } from '@pipeline/shared-types';

const MAX_REFERENCE_IMAGES = 4;

interface Props {
  jobId: string;
  target: EditTarget;
  label: string;
}

interface EditOutcome {
  lane: 'copy' | 'style' | 'pixel';
  reason: string;
  verification?: { qaScore: number; qaReasoning: string; allFieldsPassed: boolean };
  dimensionsStale: boolean;
}

const LANE_LABEL: Record<EditOutcome['lane'], string> = {
  copy: 'text change',
  style: 'style change',
  pixel: 'full re-render',
};

/**
 * UI for POST /api/v1/jobs/:id/edit.
 *
 * For a poster, the backend translates the instruction into a structured
 * patch against the poster's stored copy/style spec and re-renders the
 * text layer from the immutable photo+logo base - so repeated edits stay
 * one generation from clean instead of stacking on each other. Up to
 * MAX_REFERENCE_IMAGES reference images can be attached; a concrete
 * visual target transfers style far more reliably than prose.
 *
 * The call is synchronous and can take up to ~90s, so the button stays
 * disabled with a spinner for the whole wait rather than optimistically
 * closing early.
 */
export function ImproveAsset({ jobId, target, label }: Props) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<EditOutcome | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();

  const editMutation = useMutation({
    mutationFn: async (): Promise<EditOutcome> => {
      const formData = new FormData();
      formData.append('target', target);
      formData.append('instruction', instruction.trim());
      for (const image of images) formData.append('referenceImages', image);

      const res = await fetch(`/api/v1/jobs/${jobId}/edit`, { method: 'POST', body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? 'Edit failed - please try again.');
      return body.data as EditOutcome;
    },
    onMutate: () => {
      setError(null);
      setOutcome(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Edit failed - please try again.'),
    onSuccess: (data) => {
      setInstruction('');
      setImages([]);
      setOpen(false);
      // Kept after close so the result stays visible - the lane and the
      // verification verdict are the useful part ("it changed the CTA
      // text", "the CTA still reads JOIN TODAY").
      setOutcome(data);
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
  });

  function addFiles(selected: FileList | null) {
    if (!selected) return;
    setImages((prev) => [...prev, ...Array.from(selected)].slice(0, MAX_REFERENCE_IMAGES));
    // Reset so picking the same file twice in a row still fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  if (!open) {
    return (
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-primary flex items-center gap-1 text-[11.5px] font-semibold hover:underline"
        >
          <Wand2 className="size-3" /> Improve this {label}
        </button>
        {outcome && (
          <div className="space-y-1 text-[11px]">
            <p className="text-muted-foreground">
              Applied as a <span className="font-semibold">{LANE_LABEL[outcome.lane]}</span>
              {outcome.reason ? ` - ${outcome.reason}` : ''}
            </p>
            {outcome.verification && (
              <p
                className={
                  outcome.verification.allFieldsPassed ? 'text-success flex items-start gap-1' : 'text-attention flex items-start gap-1'
                }
              >
                {outcome.verification.allFieldsPassed ? (
                  <Check className="mt-0.5 size-3 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                )}
                <span>
                  {outcome.verification.allFieldsPassed
                    ? `Verified ${outcome.verification.qaScore}/10`
                    : `Check this one: ${outcome.verification.qaReasoning}`}
                </span>
              </p>
            )}
            {outcome.dimensionsStale && (
              <p className="text-attention flex items-start gap-1">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>The existing dimensions came from the previous poster and no longer match it.</span>
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border-border bg-secondary/30 space-y-2 rounded-lg border p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] font-semibold">Improve {label}</span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={editMutation.isPending}
          className="text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <Textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="e.g. change the CTA to JOIN NOW, make the CTA green..."
        rows={2}
        maxLength={500}
        disabled={editMutation.isPending}
        className="text-[12.5px]"
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => addFiles(e.target.files)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {images.map((image, i) => (
          <span
            key={`${image.name}-${i}`}
            className="border-border text-muted-foreground flex h-7 items-center gap-1.5 rounded-full border pr-2 pl-2 text-[11px]"
          >
            <img src={URL.createObjectURL(image)} alt="" className="size-4 rounded-full object-cover" />
            <span className="max-w-[110px] truncate">{image.name}</span>
            <button
              type="button"
              onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={editMutation.isPending}
              title="Remove"
              className="hover:text-destructive disabled:opacity-40"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {images.length < MAX_REFERENCE_IMAGES && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={editMutation.isPending}
            title="Attach reference image(s) (optional)"
            className="border-border text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40 flex h-7 items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-[11px] font-medium transition-colors"
          >
            <ImagePlus className="size-3.5" strokeWidth={1.75} />
            {images.length === 0 ? 'Reference image' : 'Add another'}
          </button>
        )}
      </div>

      {error && <p className="text-destructive text-[11px]">{error}</p>}
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => editMutation.mutate()}
          disabled={editMutation.isPending || instruction.trim().length < 3}
        >
          {editMutation.isPending ? (
            <>
              <Loader2 className="animate-spin" /> Applying (up to ~90s)...
            </>
          ) : (
            <>
              <Wand2 /> Apply edit
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
