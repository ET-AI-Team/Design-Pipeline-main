import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
  src: string | null;
  onClose: () => void;
}

/**
 * Full-size in-page image preview. Every thumbnail in the trace used to
 * link out with target="_blank", spawning a new browser tab per click -
 * this renders the same preview as an overlay instead, dismissed via
 * backdrop click, the close button, or Escape.
 */
export function ImageLightbox({ src, onClose }: Props) {
  useEffect(() => {
    if (!src) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [src, onClose]);

  if (!src) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-10"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute top-5 right-5 flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="size-5" />
      </button>
      <img
        src={src}
        alt="Preview"
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}
