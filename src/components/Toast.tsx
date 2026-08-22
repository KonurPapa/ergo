import React, { useEffect } from 'react';
import { Key, AlertCircle, CheckCircle2, Info, X, Undo2 } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type?: 'warning' | 'info' | 'error' | 'success';
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

const ToastItem: React.FC<{ toast: ToastMessage; onDismiss: (id: string) => void }> = ({
  toast,
  onDismiss,
}) => {
  useEffect(() => {
    const duration = toast.duration ?? 5000;
    if (duration <= 0) return;
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, duration);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  const renderIcon = () => {
    switch (toast.type) {
      case 'warning':
        return <Key size={18} color="var(--accent-amber)" />;
      case 'error':
        return <AlertCircle size={18} color="var(--accent-rose)" />;
      case 'success':
        return <CheckCircle2 size={18} color="var(--accent-emerald)" />;
      case 'info':
      default:
        return <Info size={18} color="var(--accent-cyan)" />;
    }
  };

  const getBorderColor = () => {
    switch (toast.type) {
      case 'warning':
        return 'rgba(245, 158, 11, 0.4)';
      case 'error':
        return 'rgba(244, 63, 94, 0.4)';
      case 'success':
        return 'rgba(16, 185, 129, 0.4)';
      case 'info':
      default:
        return 'rgba(6, 182, 212, 0.4)';
    }
  };

  return (
    <div
      className="toast-card"
      style={{
        borderColor: getBorderColor(),
      }}
    >
      <div className="toast-icon-wrapper">{renderIcon()}</div>
      <div className="toast-content">
        <div className="toast-title">{toast.title}</div>
        <div className="toast-message">{toast.message}</div>
        {toast.actionLabel && toast.onAction && (
          <button
            type="button"
            className="toast-action-btn"
            onClick={() => {
              toast.onAction?.();
              onDismiss(toast.id);
            }}
          >
            {toast.actionLabel.toLowerCase().includes('undo') ? <Undo2 size={13} /> : <Key size={13} />}
            <span>{toast.actionLabel}</span>
          </button>
        )}
      </div>
      <button
        type="button"
        className="toast-close-btn"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
};

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-viewport">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
};
