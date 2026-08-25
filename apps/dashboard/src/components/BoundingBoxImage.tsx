import { useState } from 'react';

interface Props {
  src: string;
  alt: string;
  box?: { x: number; y: number; width: number; height: number } | null;
  className?: string;
}

/**
 * Renders an image, and if a bounding box is given, draws it as an
 * overlay rectangle scaled to the image's actual displayed size - lets
 * you see exactly what the logo-detection stage's vision call picked
 * as the clean zone, not just trust the coordinates blindly.
 */
export function BoundingBoxImage({ src, alt, box, className }: Props) {
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  return (
    <div className={`relative ${className ?? ''}`}>
      <img
        src={src}
        alt={alt}
        className="h-full w-full rounded-md border object-cover"
        onLoad={(e) => {
          const img = e.currentTarget;
          setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
        }}
      />
      {box && naturalSize && (
        <div
          className="border-primary bg-primary/10 pointer-events-none absolute border-2"
          style={{
            left: `${(box.x / naturalSize.w) * 100}%`,
            top: `${(box.y / naturalSize.h) * 100}%`,
            width: `${(box.width / naturalSize.w) * 100}%`,
            height: `${(box.height / naturalSize.h) * 100}%`,
          }}
        />
      )}
    </div>
  );
}
