import React, { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { Button, Icon, IconButton } from './ui';

export interface ToastAction {
  label: string;
  /** primary/emerald → the accent button (at most one per toast), danger → danger text, the rest secondary. */
  variant?: 'primary' | 'secondary' | 'emerald' | 'danger' | 'amber';
  onClick: () => void;
  icon?: React.ReactNode;
}

export interface ToastMessage {
  id: string;
  type?: 'warning' | 'info' | 'error' | 'success';
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  actions?: ToastAction[];
  duration?: number;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

/** At most this many toasts show at once (the newest). */
const MAX_VISIBLE = 3;

const TONE = {
  success: { cls: 'eg-toast-success', icon: CircleCheck },
  warning: { cls: 'eg-toast-warning', icon: TriangleAlert },
  error: { cls: 'eg-toast-danger', icon: CircleX },
  info: { cls: 'eg-toast-neutral', icon: Info },
} as const;

/** "Error: x failed!" → "x failed." — problems are stated calmly. */
function calm(text: string): string {
  return text.replace(/^\s*(error|warning)\s*:\s*/i, '').replace(/!+(\s|$)/g, '.$1').replace(/\.\.(\s|$)/g, '.$1');
}

const ToastItem: React.FC<{ toast: ToastMessage; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  const [hovered, setHovered] = useState(false);
  const tone = TONE[toast.type ?? 'info'];
  // Success and neutral toasts leave after 6s, warnings and failures after 15s (paused while hovered), unless the
  // caller set a duration.
  const duration = toast.duration ?? (toast.type === 'warning' || toast.type === 'error' ? 15000 : 6000);
  const remaining = useRef(duration);
  const startedAt = useRef(0);

  useEffect(() => {
    if (duration <= 0 || hovered) return;
    startedAt.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), Math.max(0, remaining.current));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [toast.id, duration, hovered, onDismiss]);

  const actions: ToastAction[] =
    toast.actions && toast.actions.length > 0
      ? toast.actions
      : toast.actionLabel && toast.onAction
        ? [{ label: toast.actionLabel, onClick: toast.onAction }]
        : [];

  return (
    <div
      className={`eg-toast ${tone.cls} dlg-toast`}
      role={toast.type === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="eg-toast-icon">
        <Icon icon={tone.icon} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="eg-toast-title">{calm(toast.title)}</div>
        {toast.message && <div className="eg-toast-text">{calm(toast.message)}</div>}
        {actions.length > 0 && (
          <div className="dlg-toast-actions">
            {actions.map((act, idx) => (
              <Button
                key={idx}
                size="sm"
                variant={act.variant === 'primary' || act.variant === 'emerald' ? 'primary' : act.variant === 'danger' ? 'danger' : 'secondary'}
                onClick={() => {
                  act.onClick();
                  onDismiss(toast.id);
                }}
              >
                {act.icon}
                {act.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <IconButton icon={X} label="Dismiss" size="sm" onClick={() => onDismiss(toast.id)} />
    </div>
  );
};

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="dlg-toast-stack" aria-live="polite">
      {toasts.slice(-MAX_VISIBLE).map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
};
