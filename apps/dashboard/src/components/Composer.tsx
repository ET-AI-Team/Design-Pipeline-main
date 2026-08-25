import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ArrowUp, ImagePlus, Shapes, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  onSubmitted: (jobId: string) => void;
}

interface Slot {
  key: 'reference1' | 'reference2' | 'logo';
  label: string;
  short: string;
  accept: string;
  icon: LucideIcon;
}

const SLOTS: Slot[] = [
  {
    key: 'reference1',
    label: 'Reference 1 (base direction)',
    short: 'Ref 1',
    accept: 'image/jpeg,image/png,image/webp',
    icon: ImagePlus,
  },
  {
    key: 'reference2',
    label: 'Reference 2 (layout)',
    short: 'Ref 2',
    accept: 'image/jpeg,image/png,image/webp',
    icon: ImagePlus,
  },
  { key: 'logo', label: 'Logo', short: 'Logo', accept: 'image/png,image/svg+xml', icon: Shapes },
];

export function Composer({ onSubmitted }: Props) {
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<Partial<Record<Slot['key'], File>>>({});
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<Partial<Record<Slot['key'], HTMLInputElement | null>>>({});
  const queryClient = useQueryClient();

  function setFile(key: Slot['key'], file: File | undefined) {
    setFiles((prev) => ({ ...prev, [key]: file }));
  }

  const submitMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append('prompt', prompt);
      for (const slot of SLOTS) formData.append(slot.key, files[slot.key]!);
      const res = await fetch('/api/v1/jobs', { method: 'POST', body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? 'Submission failed');
      return body.data.jobId as string;
    },
    onSuccess: (jobId) => {
      setPrompt('');
      setFiles({});
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      onSubmitted(jobId);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Network error - check the API is running.'),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (prompt.trim().length < 10) {
      setError('Prompt must be at least 10 characters.');
      return;
    }
    for (const slot of SLOTS) {
      if (!files[slot.key]) {
        setError(`${slot.label} is required.`);
        return;
      }
    }

    submitMutation.mutate();
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-7 px-6 py-14">
      <h1 className="text-foreground text-center text-[28px] font-bold tracking-tight">
        What should we create today?
      </h1>

      <form onSubmit={handleSubmit} className="w-full max-w-[680px]">
        <div className="border-border bg-card rounded-[26px] border p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_20px_44px_-28px_rgba(0,0,0,0.18)]">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the campaign theme, tone, and any specific copy requirements..."
            minLength={10}
            maxLength={2000}
            rows={1}
            className="min-h-[28px] resize-none border-none px-2.5 py-1.5 text-[15px] shadow-none focus-visible:ring-0"
          />

          <div className="mt-1 flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5">
              {SLOTS.map((slot) => {
                const file = files[slot.key];
                const Icon = slot.icon;
                return (
                  <div key={slot.key}>
                    <input
                      ref={(el) => {
                        inputRefs.current[slot.key] = el;
                      }}
                      type="file"
                      accept={slot.accept}
                      className="hidden"
                      onChange={(e) => setFile(slot.key, e.target.files?.[0])}
                    />
                    <button
                      type="button"
                      onClick={() => (file ? setFile(slot.key, undefined) : inputRefs.current[slot.key]?.click())}
                      title={file ? `Remove ${slot.label}` : slot.label}
                      className={cn(
                        'flex h-8 items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-[12px] font-medium transition-colors',
                        file
                          ? 'border-success/30 bg-success/10 text-foreground hover:border-destructive/30 hover:bg-destructive/5 hover:text-destructive'
                          : 'border-border text-muted-foreground hover:border-primary hover:text-primary'
                      )}
                    >
                      {file ? (
                        <img src={URL.createObjectURL(file)} alt="" className="size-5 rounded-full object-cover" />
                      ) : (
                        <Icon className="size-3.5" strokeWidth={1.75} />
                      )}
                      {slot.short}
                      {file && <X className="size-3" />}
                    </button>
                  </div>
                );
              })}
            </div>

            <button
              type="submit"
              disabled={submitMutation.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 flex size-9 flex-none items-center justify-center rounded-full transition-colors disabled:opacity-50"
            >
              {submitMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-destructive mt-3 text-center text-sm">
            {error}
          </p>
        )}
      </form>

      <p className="text-muted-foreground max-w-[420px] text-center text-[12.5px] leading-[1.5]">
        Attach two references and a logo, then describe the campaign - the pipeline generates, QA's, and composites
        the asset automatically.
      </p>
    </div>
  );
}
