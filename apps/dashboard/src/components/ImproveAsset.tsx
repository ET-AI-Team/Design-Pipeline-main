import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Wand2, X, ImagePlus } from 'lucide-react';
import type { EditTarget } from '@pipeline/shared-types';

interface Props {
  jobId: string;
  target: EditTarget;
  label: string;
}

/**
 * UI for POST /api/v1/jobs/:id/edit - a free-text "improve this" edit,
 * with an optional attached reference image, against whichever asset is
 * currently live for `target` (the poster, or one delivered dimension).
 * The image slot is optional - a concrete visual reference ("make the
 * CTA look like this") transfers a specific target far more reliably
 * than prose alone, but plenty of edits (color/wording tweaks) don't
 * need one. Deliberately outside the automated pipeline on the backend
 * (no QA, no retry, no version history - the new image just replaces
 * the old one in place) so this control mirrors that: one instruction
 * (+ optional image) in, the existing asset overwritten on success,
 * nothing kept to roll back to. The call is synchronous and can take up
 * to ~90s (a real Gemini edit call), so the button stays disabled with a
 * spinner for the whole wait rather than optimistically closing early.
 */
export function ImproveAsset({ jobId, target, label }: Props) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [image, setImage] = useState<File | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();

  const editMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append('target', target);
      formData.append('instruction', instruction.trim());
      if (image) formData.append('referenceImage', image);

      const res = await fetch(`/api/v1/jobs/${jobId}/edit`, { method: 'POST', body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? 'Edit failed - please try again.');
      return body.data.assetUrl as string;
    },
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : 'Edit failed - please try again.'),
    onSuccess: () => {
      setInstruction('');
      setImage(undefined);
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-primary flex items-center gap-1 text-[11.5px] font-semibold hover:underline"
      >
        <Wand2 className="size-3" /> Improve this {label}
      </button>
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
        placeholder="e.g. make the headline larger, change the CTA button to green..."
        rows={2}
        maxLength={500}
        disabled={editMutation.isPending}
        className="text-[12.5px]"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => setImage(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => (image ? setImage(undefined) : fileInputRef.current?.click())}
        disabled={editMutation.isPending}
        title={image ? 'Remove reference image' : 'Attach a reference image (optional)'}
        className="border-border text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40 flex h-7 items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-[11px] font-medium transition-colors"
      >
        {image ? (
          <img src={URL.createObjectURL(image)} alt="" className="size-4 rounded-full object-cover" />
        ) : (
          <ImagePlus className="size-3.5" strokeWidth={1.75} />
        )}
        {image ? image.name : 'Reference image'}
        {image && <X className="size-3" />}
      </button>

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
