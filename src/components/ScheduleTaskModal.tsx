import React, { useState } from 'react';
import { Calendar as CalendarIcon, X, Check, Trash2 } from 'lucide-react';
import { type TaskItem } from '../types';
import { type ScheduledJob } from '../lib/taskScheduler';

interface ScheduleTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: TaskItem;
  existingJob?: ScheduledJob;
  onSchedule: (taskId: string | number, scheduledIso: string, cronExpr?: string) => void;
  onCancelSchedule?: (taskId: string | number) => void;
}

export const ScheduleTaskModal: React.FC<ScheduleTaskModalProps> = ({
  isOpen,
  onClose,
  task,
  existingJob,
  onSchedule,
  onCancelSchedule,
}) => {
  // Initialize default date/time (e.g. 1 hour from now or existing scheduled time)
  const defaultDateTime = () => {
    if (existingJob?.scheduledTime) {
      const d = new Date(existingJob.scheduledTime);
      if (!isNaN(d.getTime())) {
        const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 16);
      }
    }
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  };

  const [dateTime, setDateTime] = useState<string>(defaultDateTime);
  const [repeatType, setRepeatType] = useState<'once' | 'hourly' | 'daily' | 'weekly'>('once');
  const [error, setError] = useState<string>('');

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dateTime) {
      setError('Please select a valid date and time.');
      return;
    }

    const selectedDate = new Date(dateTime);
    if (isNaN(selectedDate.getTime())) {
      setError('Invalid date format.');
      return;
    }

    const now = new Date();
    if (selectedDate.getTime() <= now.getTime()) {
      setError('Scheduled time must be in the future.');
      return;
    }

    let cronExpr: string | undefined = undefined;
    const min = selectedDate.getMinutes();
    const hour = selectedDate.getHours();
    const dayOfWeek = selectedDate.getDay();

    if (repeatType === 'hourly') {
      cronExpr = `${min} * * * *`;
    } else if (repeatType === 'daily') {
      cronExpr = `${min} ${hour} * * *`;
    } else if (repeatType === 'weekly') {
      cronExpr = `${min} ${hour} * * ${dayOfWeek}`;
    }

    onSchedule(task.id, selectedDate.toISOString(), cronExpr);
    onClose();
  };

  const handleRemove = () => {
    if (onCancelSchedule) {
      onCancelSchedule(task.id);
    }
    onClose();
  };

  // Quick preset helpers
  const setPreset = (minutesAhead: number) => {
    const d = new Date(Date.now() + minutesAhead * 60 * 1000);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    setDateTime(local.toISOString().slice(0, 16));
    setError('');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '460px',
          width: '95vw',
          background: 'var(--bg-pane, #222427)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '12px',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.6), 0 0 20px rgba(99, 102, 241, 0.15)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(99, 102, 241, 0.15)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-primary, #6366f1)',
              }}
            >
              <CalendarIcon size={16} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-bright, #fff)' }}>
                Schedule Task Execution
              </h3>
              <p style={{ margin: '0.15rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Set date & time for automated task execution
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            title="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Target Task Title */}
          <div
            style={{
              padding: '0.6rem 0.85rem',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span
              style={{
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono, monospace)',
                color: 'var(--accent-primary, #6366f1)',
                background: 'rgba(99, 102, 241, 0.15)',
                padding: '0.1rem 0.4rem',
                borderRadius: '4px',
              }}
            >
              #{task.listIndex ?? task.id}
            </span>
            <span
              style={{
                fontSize: '0.82rem',
                fontWeight: 500,
                color: 'var(--text-main, #e2e8f0)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={task.title}
            >
              {task.title}
            </span>
          </div>

          {/* Quick Preset Buttons */}
          <div>
            <label style={{ display: 'block', fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: 500 }}>
              Quick Presets
            </label>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ai-card-btn"
                style={{ fontSize: '0.72rem', height: '26px' }}
                onClick={() => setPreset(15)}
              >
                +15 mins
              </button>
              <button
                type="button"
                className="ai-card-btn"
                style={{ fontSize: '0.72rem', height: '26px' }}
                onClick={() => setPreset(60)}
              >
                +1 hour
              </button>
              <button
                type="button"
                className="ai-card-btn"
                style={{ fontSize: '0.72rem', height: '26px' }}
                onClick={() => setPreset(180)}
              >
                +3 hours
              </button>
              <button
                type="button"
                className="ai-card-btn"
                style={{ fontSize: '0.72rem', height: '26px' }}
                onClick={() => setPreset(1440)}
              >
                Tomorrow (+24h)
              </button>
            </div>
          </div>

          {/* Date & Time Picker */}
          <div>
            <label style={{ display: 'block', fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: 500 }}>
              Select Date & Time (Calendar)
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type="datetime-local"
                value={dateTime}
                onChange={(e) => {
                  setDateTime(e.target.value);
                  setError('');
                }}
                style={{
                  width: '100%',
                  height: '36px',
                  padding: '0 0.75rem',
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: error ? '1px solid #f43f5e' : '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '6px',
                  color: 'var(--text-bright, #fff)',
                  fontSize: '0.84rem',
                  colorScheme: 'dark',
                  outline: 'none',
                }}
              />
            </div>
            {error && (
              <span style={{ fontSize: '0.72rem', color: '#f43f5e', marginTop: '0.3rem', display: 'block' }}>
                {error}
              </span>
            )}
          </div>

          {/* Recurrence / Cron Mode */}
          <div>
            <label style={{ display: 'block', fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: 500 }}>
              Recurrence (Cron Schedule)
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.4rem' }}>
              {(['once', 'hourly', 'daily', 'weekly'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`ai-card-btn ${repeatType === mode ? 'is-primary' : ''}`}
                  onClick={() => setRepeatType(mode)}
                  style={{
                    height: '28px',
                    fontSize: '0.74rem',
                    textTransform: 'capitalize',
                    justifyContent: 'center',
                    background: repeatType === mode ? 'var(--accent-primary, #6366f1)' : 'rgba(255, 255, 255, 0.04)',
                    borderColor: repeatType === mode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                  }}
                >
                  {mode === 'once' ? 'Run once' : mode}
                </button>
              ))}
            </div>
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              {repeatType === 'once'
                ? 'Task will trigger automatically at the specified date & time.'
                : `Task will trigger as a recurring cron job (${repeatType}). If the browser is closed, it will run upon reopening.`}
            </p>
          </div>

          {/* Action Footer */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '0.5rem',
              paddingTop: '0.85rem',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            {existingJob ? (
              <button
                type="button"
                className="ai-card-btn"
                onClick={handleRemove}
                style={{ color: '#f43f5e', borderColor: 'rgba(244, 63, 94, 0.3)' }}
                title="Cancel existing scheduled job"
              >
                <Trash2 size={13} />
                <span>Remove Schedule</span>
              </button>
            ) : (
              <div />
            )}

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="ai-card-btn"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="ai-card-btn is-primary"
                style={{ gap: '0.35rem' }}
              >
                <Check size={13} />
                <span>{existingJob ? 'Update Schedule' : 'Schedule Task'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
