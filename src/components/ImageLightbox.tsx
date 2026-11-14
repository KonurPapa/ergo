/** A task's screenshots full size: one at a time, ← / → between them, Escape or a click outside closes. */
import React, { useEffect } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { Dialog, IconButton } from './ui';
import type { TaskImage } from '../lib/taskImages';

export const ImageLightbox: React.FC<{
  images: TaskImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}> = ({ images, index, onIndex, onClose }) => {
  const count = images.length;
  const image = images[Math.max(0, Math.min(index, count - 1))];

  useEffect(() => {
    if (count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onIndex((index - 1 + count) % count);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onIndex((index + 1) % count);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, count, onIndex]);

  if (!image) return null;
  return (
    <Dialog
      title={image.alt || 'Image'}
      description={count > 1 ? `${index + 1} of ${count}` : undefined}
      onClose={onClose}
      width={1200}
      className="eg-lightbox"
      headerActions={
        <>
          {count > 1 && (
            <>
              <IconButton icon={ChevronLeft} label="Previous image (←)" size="sm" onClick={() => onIndex((index - 1 + count) % count)} />
              <IconButton icon={ChevronRight} label="Next image (→)" size="sm" onClick={() => onIndex((index + 1) % count)} />
            </>
          )}
          {!image.src.startsWith('data:') && (
            <IconButton icon={ExternalLink} label="Open in a new tab" size="sm" onClick={() => window.open(image.src, '_blank', 'noopener,noreferrer')} />
          )}
        </>
      }
    >
      <div className="eg-lightbox-stage">
        <img src={image.src} alt={image.alt} draggable={false} />
      </div>
    </Dialog>
  );
};
