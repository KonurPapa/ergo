import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button, Dialog, Field, Input, SegmentedControl } from './ui';
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
      setError('Pick a date and time.');
      return;
    }

    const selectedDate = new Date(dateTime);
    if (isNaN(selectedDate.getTime())) {
      setError('That date isn’t valid.');
      return;
    }

    const now = new Date();
    if (selectedDate.getTime() <= now.getTime()) {
      setError('Pick a time in the future.');
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

  const formId = `schedule-task-${String(task.id)}`;

  return (
    <Dialog
      title={existingJob ? 'Change schedule' : 'Schedule this task'}
      description="Pick when the task runs on its own."
      onClose={onClose}
      width={460}
      footer={
        <>
          {existingJob && (
            <Button variant="danger" size="lg" icon={Trash2} onClick={handleRemove} title="Cancel the scheduled run">
              Remove schedule
            </Button>
          )}
          <span className="eg-spacer" />
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" type="submit" form={formId}>
            {existingJob ? 'Update schedule' : 'Schedule'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="eg-hstack" style={{ minWidth: 0 }}>
          <span className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))', lineHeight: 'calc(16px * var(--type-scale))', color: 'var(--ink-subtle)' }}>
            #{task.listIndex ?? task.id}
          </span>
          <span
            style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={task.title}
          >
            {task.title}
          </span>
        </div>

        <div className="eg-field">
          <span className="eg-field-label">Quick picks</span>
          <div className="eg-hstack" style={{ flexWrap: 'wrap', gap: 'var(--space-1)' }}>
            <Button size="sm" onClick={() => setPreset(15)}>In 15 min</Button>
            <Button size="sm" onClick={() => setPreset(60)}>In 1 hour</Button>
            <Button size="sm" onClick={() => setPreset(180)}>In 3 hours</Button>
            <Button size="sm" onClick={() => setPreset(1440)}>Tomorrow</Button>
          </div>
        </div>

        <Field label="Date and time" error={error || undefined}>
          <Input
            type="datetime-local"
            value={dateTime}
            invalid={!!error}
            autoFocus
            onChange={(e) => {
              setDateTime(e.target.value);
              setError('');
            }}
            style={{ height: 'var(--size-control-lg)' }}
          />
        </Field>

        <div className="eg-field">
          <span className="eg-field-label">Repeat</span>
          <SegmentedControl
            full
            label="Repeat"
            value={repeatType}
            onChange={setRepeatType}
            options={[
              { id: 'once', label: 'Once' },
              { id: 'hourly', label: 'Hourly' },
              { id: 'daily', label: 'Daily' },
              { id: 'weekly', label: 'Weekly' },
            ]}
          />
          <span className="eg-field-help">
            {repeatType === 'once'
              ? 'Runs once at the time above.'
              : `Runs ${repeatType}, starting at the time above. If the browser is closed then, it runs when you reopen it.`}
          </span>
        </div>
      </form>
    </Dialog>
  );
};
