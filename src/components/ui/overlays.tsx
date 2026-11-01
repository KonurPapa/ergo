/** Floating surfaces: Menu (with an anchored popover) and Dialog. */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { Check, X } from 'lucide-react';
import { Icon, IconButton, cx } from './primitives';

export type MenuItem =
  | {
      label: React.ReactNode;
      icon?: LucideIcon;
      hint?: React.ReactNode;
      danger?: boolean;
      checked?: boolean;
      active?: boolean;
      disabled?: boolean;
      title?: string;
      onSelect?: () => void;
    }
  | { separator: true }
  | { section: React.ReactNode };

/** The menu surface itself; Popover places it next to an anchor. */
export const Menu: React.FC<{ items: MenuItem[]; style?: React.CSSProperties; className?: string; onClose?: () => void }> = ({
  items,
  style,
  className,
  onClose,
}) => (
  <div className={cx('eg-menu', className)} role="menu" style={style}>
    {items.map((it, i) => {
      if ('separator' in it) return <div key={i} className="eg-menu-sep" role="separator" />;
      if ('section' in it) return <div key={i} className="eg-menu-label">{it.section}</div>;
      return (
        <button
          key={i}
          type="button"
          role={it.checked != null ? 'menuitemcheckbox' : 'menuitem'}
          aria-checked={it.checked != null ? !!it.checked : undefined}
          className={cx('eg-menu-item', it.danger && 'eg-menu-item-danger')}
          data-active={it.active ? 'true' : undefined}
          disabled={it.disabled}
          title={it.title}
          onClick={() => {
            it.onSelect?.();
            onClose?.();
          }}
        >
          {it.icon && <Icon icon={it.icon} />}
          <span className="eg-menu-text">{it.label}</span>
          {it.checked ? <Icon icon={Check} className="eg-menu-check" /> : it.hint && <span className="eg-menu-hint">{it.hint}</span>}
        </button>
      );
    })}
  </div>
);

/**
 * A popover anchored to an element: placed below it (or above when there is no room), closed by
 * Escape or a click outside. Rendered in a portal so pane overflow never clips it.
 */
export const Popover: React.FC<{
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end';
  placement?: 'below' | 'above';
  children: React.ReactNode;
  className?: string;
  width?: number;
}> = ({ anchor, open, onClose, align = 'start', placement = 'below', children, className, width }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      const w = el?.offsetWidth ?? width ?? 220;
      const h = el?.offsetHeight ?? 0;
      let left = align === 'end' ? a.right - w : a.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      const below = a.bottom + 4;
      const above = a.top - 4 - h;
      const top = placement === 'above' ? (above >= 8 ? above : below) : below + h > window.innerHeight - 8 && above >= 8 ? above : below;
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, align, placement, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open || !anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className={cx('eg-popover', className)}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, zIndex: 'var(--z-popover)' as unknown as number }}
    >
      {children}
    </div>,
    document.body,
  );
};

/** A button that opens a menu. `trigger` receives the props to spread on its button. */
export const MenuButton: React.FC<{
  items: MenuItem[];
  align?: 'start' | 'end';
  placement?: 'below' | 'above';
  width?: number;
  trigger: (p: { ref: React.Ref<HTMLButtonElement>; onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => React.ReactNode;
}> = ({ items, align, placement, width, trigger }) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      {trigger({ ref: setAnchor, onClick: () => setOpen((v) => !v), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align={align} placement={placement} width={width}>
        <Menu items={items} onClose={() => setOpen(false)} style={width ? { width } : undefined} />
      </Popover>
    </>
  );
};

export interface DialogProps {
  open?: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose?: () => void;
  width?: number;
  className?: string;
  /** Extra controls in the header, before Close. */
  headerActions?: React.ReactNode;
}

/** A dialog on a scrim: Escape and a click on the scrim close it. */
export const Dialog: React.FC<DialogProps> = ({ open = true, title, description, children, footer, onClose, width, className, headerActions }) => {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div
      className="eg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className={cx('eg-dialog', className)} role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        <div className="eg-dialog-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="eg-dialog-title">{title}</h2>
            {description && <p className="eg-dialog-desc">{description}</p>}
          </div>
          {headerActions}
          {onClose && <IconButton icon={X} label="Close" size="sm" onClick={onClose} />}
        </div>
        <div className="eg-dialog-body">{children}</div>
        {footer && <div className="eg-dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};
