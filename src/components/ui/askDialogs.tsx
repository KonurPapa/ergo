/**
 * App-styled replacements for window.confirm / window.prompt: `await askConfirm({...})` and `await askText({...})`
 * open a Dialog through <AskDialogHost>, which App mounts once.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Button, Input } from './primitives';
import { Dialog } from './overlays';

export interface ConfirmOptions {
  title: string;
  /** What happens, stated calmly. */
  text?: React.ReactNode;
  /** The verb naming the outcome ("Delete skill"). */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive: the confirm button uses the danger style. */
  danger?: boolean;
}

export interface TextOptions {
  title: string;
  text?: React.ReactNode;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel: string;
  /** Allow submitting an empty value (e.g. to clear a link). */
  allowEmpty?: boolean;
  mono?: boolean;
}

type Request =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'text'; opts: TextOptions; resolve: (value: string | null) => void };

let enqueue: ((r: Request) => void) | null = null;
const pending: Request[] = [];

function push(r: Request) {
  if (enqueue) enqueue(r);
  else pending.push(r);
}

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => push({ kind: 'confirm', opts, resolve }));
}

export function askText(opts: TextOptions): Promise<string | null> {
  return new Promise((resolve) => push({ kind: 'text', opts, resolve }));
}

const TextBody: React.FC<{ opts: TextOptions; value: string; onChange: (v: string) => void; onSubmit: () => void }> = ({
  opts,
  value,
  onChange,
  onSubmit,
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <>
      {opts.text && <p style={{ margin: '0 0 var(--space-3)' }}>{opts.text}</p>}
      <label className="eg-field">
        {opts.label && <span className="eg-field-label">{opts.label}</span>}
        <Input
          ref={ref}
          mono={opts.mono}
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </label>
    </>
  );
};

/** Renders the open confirm / text dialog, one at a time. */
export const AskDialogHost: React.FC = () => {
  const [queue, setQueue] = useState<Request[]>(() => pending.splice(0));
  const [value, setValue] = useState('');

  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    return () => {
      enqueue = null;
    };
  }, []);

  const current = queue[0];
  useEffect(() => {
    if (current?.kind === 'text') setValue(current.opts.defaultValue ?? '');
  }, [current]);

  if (!current) return null;
  const finish = (result: boolean) => {
    if (current.kind === 'confirm') current.resolve(result);
    else current.resolve(result ? value : null);
    setQueue((q) => q.slice(1));
  };

  if (current.kind === 'confirm') {
    const { opts } = current;
    return (
      <Dialog
        title={opts.title}
        onClose={() => finish(false)}
        width={440}
        footer={
          <>
            <span className="eg-spacer" />
            <Button onClick={() => finish(false)}>{opts.cancelLabel ?? 'Cancel'}</Button>
            <Button variant={opts.danger ? 'danger' : 'primary'} onClick={() => finish(true)} autoFocus>
              {opts.confirmLabel}
            </Button>
          </>
        }
      >
        {opts.text ?? null}
      </Dialog>
    );
  }

  const { opts } = current;
  const canSubmit = opts.allowEmpty || value.trim() !== '';
  return (
    <Dialog
      title={opts.title}
      onClose={() => finish(false)}
      width={440}
      footer={
        <>
          <span className="eg-spacer" />
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => finish(true)}>
            {opts.confirmLabel}
          </Button>
        </>
      }
    >
      <TextBody opts={opts} value={value} onChange={setValue} onSubmit={() => canSubmit && finish(true)} />
    </Dialog>
  );
};
