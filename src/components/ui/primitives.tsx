/**
 * Ergo design-system primitives (eg- classes in src/styles/ergo.css).
 * Ported from public/design/ergo-design/components/bundle.js; see each component's README there.
 */
import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleX, Info, TriangleAlert, Inbox } from 'lucide-react';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type DesignTaskStatus = 'todo' | 'queued' | 'progress' | 'review' | 'done' | 'failed';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

/** A Lucide icon at the design's sizes: 16px, or 14px in rows, menus and small buttons. */
export const Icon: React.FC<{ icon: LucideIcon; size?: 'md' | 'sm'; className?: string; style?: React.CSSProperties }> = ({
  icon: I,
  size = 'md',
  className,
  style,
}) => (
  <span className={cx('eg-icon', size === 'sm' && 'eg-icon-sm', className)} style={style} aria-hidden="true">
    <I strokeWidth={1.75} />
  </span>
);

export const Kbd: React.FC<{ keys: string | string[] }> = ({ keys }) => (
  <span className="eg-kbds">
    {(Array.isArray(keys) ? keys : [keys]).map((k, i) => (
      <kbd key={i} className="eg-kbd">
        {k}
      </kbd>
    ))}
  </span>
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = the one main action in a view (Run, Approve). Default secondary. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  /** Shortcut hint rendered as Kbd inside the button. */
  kbd?: string | string[];
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', icon, iconRight, kbd, className, children, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cx('eg-btn', `eg-btn-${variant}`, size !== 'md' && `eg-btn-${size}`, className)}
      {...rest}
    >
      {icon && <Icon icon={icon} />}
      {children}
      {iconRight && <Icon icon={iconRight} />}
      {kbd && <Kbd keys={kbd} />}
    </button>
  ),
);
Button.displayName = 'Button';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Required: becomes aria-label and tooltip. */
  label: string;
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger';
  size?: 'sm' | 'md';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, variant = 'ghost', size = 'md', className, type = 'button', title, ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cx('eg-btn', 'eg-btn-icon', `eg-btn-${variant}`, size === 'sm' && 'eg-btn-sm', className)}
      {...rest}
    >
      <Icon icon={icon} />
    </button>
  ),
);
IconButton.displayName = 'IconButton';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: LucideIcon;
  kbd?: string | string[];
  invalid?: boolean;
  /** Paths, commands, model IDs. */
  mono?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ icon, kbd, invalid, mono, className, ...rest }, ref) => {
  const input = (
    <input
      ref={ref}
      className={cx('eg-input', mono && 'eg-input-mono', invalid && 'is-invalid', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
  if (!icon && !kbd) return input;
  return (
    <div className="eg-input-wrap">
      {icon && <Icon icon={icon} />}
      {input}
      {kbd && <Kbd keys={kbd} />}
    </div>
  );
});
Input.displayName = 'Input';

export const Field: React.FC<{ label?: string; help?: React.ReactNode; error?: string; children: React.ReactNode }> = ({
  label,
  help,
  error,
  children,
}) => (
  <label className="eg-field">
    {label && <span className="eg-field-label">{label}</span>}
    {children}
    {error ? (
      <span className="eg-field-error">
        <Icon icon={CircleX} size="sm" />
        {error}
      </span>
    ) : (
      help && <span className="eg-field-help">{help}</span>
    )}
  </label>
);

export const Checkbox: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className, ...rest }) => (
  <input type="checkbox" className={cx('eg-check', className)} {...rest} />
);

export const Switch: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className, ...rest }) => (
  <input type="checkbox" role="switch" className={cx('eg-switch', className)} {...rest} />
);

export const Badge: React.FC<{ tone?: Tone; outline?: boolean; icon?: LucideIcon; className?: string; title?: string; children: React.ReactNode }> = ({
  tone = 'neutral',
  outline,
  icon,
  className,
  title,
  children,
}) => (
  <span className={cx('eg-badge', tone !== 'neutral' && `eg-badge-${tone}`, outline && 'eg-badge-outline', className)} title={title}>
    {icon && <Icon icon={icon} />}
    {children}
  </span>
);

export type DotState = 'idle' | 'live' | 'success' | 'warning' | 'danger';
export const StatusDot: React.FC<{ state?: DotState; label?: string }> = ({ state = 'idle', label }) => (
  <span className={cx('eg-dot', state !== 'idle' && `eg-dot-${state}`)} role={label ? 'img' : undefined} aria-label={label} />
);

export const STATUS_LABEL: Record<DesignTaskStatus, string> = {
  todo: 'To do',
  queued: 'Queued',
  progress: 'In progress',
  review: 'Needs review',
  done: 'Done',
  failed: 'Failed',
};

const STATUS_GLYPH: Record<DesignTaskStatus, React.ReactNode> = {
  todo: <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  queued: <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.2" />,
  progress: (
    <>
      <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
    </>
  ),
  review: (
    <>
      <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </>
  ),
  done: (
    <>
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="M4.4 7.2l1.8 1.8 3.5-3.6" fill="none" stroke="var(--canvas)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  failed: (
    <>
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="M5 5l4 4M9 5l-4 4" fill="none" stroke="var(--canvas)" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
};

export const StatusIcon: React.FC<{ status: DesignTaskStatus }> = ({ status }) => (
  <span className={cx('eg-status', `eg-status-${status}`)} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}>
    <svg viewBox="0 0 14 14" aria-hidden="true">
      {STATUS_GLYPH[status]}
    </svg>
  </span>
);

export const PRIORITY_LABEL: Record<Priority, string> = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

const bars = (n: number) =>
  [4, 7, 10].map((h, i) => (
    <rect key={i} x={1.5 + i * 4} y={12 - h} width="2.5" height={h} rx="0.75" fill="currentColor" opacity={i < n ? undefined : 0.3} />
  ));

export const PriorityIcon: React.FC<{ priority: Priority }> = ({ priority }) => (
  <span className={cx('eg-prio', priority === 'urgent' && 'eg-prio-urgent')} role="img" aria-label={PRIORITY_LABEL[priority]} title={PRIORITY_LABEL[priority]}>
    <svg viewBox="0 0 14 14" aria-hidden="true">
      {priority === 'none' && <path d="M3 7h1.5M6.25 7h1.5M9.5 7H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
      {priority === 'low' && bars(1)}
      {priority === 'medium' && bars(2)}
      {priority === 'high' && bars(3)}
      {priority === 'urgent' && (
        <>
          <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M7 4v3.5" stroke="var(--canvas)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="7" cy="10" r="0.9" fill="var(--canvas)" />
        </>
      )}
    </svg>
  </span>
);

export interface AgentStatusProps {
  state?: 'running' | 'waiting' | 'done' | 'failed' | 'idle';
  /** Agent name, shown in accent-text: "Claude Code", "Gemini CLI", "Local". */
  agent?: string;
  /** Present-tense verb phrase: "Editing", "Running tests in". */
  action: string;
  /** File, command or tool the action targets; rendered in mono. */
  target?: string;
  elapsed?: string;
  tokens?: string;
  onClick?: () => void;
  title?: string;
}

const AGENT_DOT: Record<NonNullable<AgentStatusProps['state']>, DotState> = {
  running: 'live',
  waiting: 'warning',
  done: 'success',
  failed: 'danger',
  idle: 'idle',
};

export const AgentStatus: React.FC<AgentStatusProps> = ({ state = 'running', agent, action, target, elapsed, tokens, onClick, title }) => {
  const body = (
    <>
      <StatusDot state={AGENT_DOT[state]} />
      <span className="eg-agent-text">
        {agent && <b>{agent} </b>}
        {action}
        {target && (
          <>
            {' '}
            <code>{target}</code>
          </>
        )}
      </span>
      {(elapsed || tokens) && <span className="eg-agent-meta">{[elapsed, tokens].filter(Boolean).join(' · ')}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="eg-agent" onClick={onClick} aria-live="polite" title={title}>
      {body}
    </button>
  ) : (
    <span className="eg-agent" aria-live="polite" title={title}>
      {body}
    </span>
  );
};

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  count?: number;
  icon?: LucideIcon;
  /** Small trailing marker (an alert or live dot). */
  marker?: React.ReactNode;
  /** Not available yet: shown greyed out and can't be selected. */
  disabled?: boolean;
  title?: string;
}

export function Tabs<T extends string>({ items, value, onChange, className }: { items: TabItem<T>[]; value: T; onChange?: (id: T) => void; className?: string }) {
  return (
    <div className={cx('eg-tabs', className)} role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          className="eg-tab"
          aria-selected={t.id === value}
          disabled={t.disabled}
          title={t.title}
          onClick={() => !t.disabled && onChange?.(t.id)}
        >
          {t.icon && <Icon icon={t.icon} size="sm" />}
          {t.label}
          {t.count != null && <span className="eg-count">{t.count}</span>}
          {t.marker}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  full,
  disabled,
}: {
  options: Array<T | { id: T; label: string; title?: string }>;
  value: T;
  onChange?: (id: T) => void;
  label?: string;
  full?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={cx('eg-seg', full && 'eg-seg-full')} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const id = typeof o === 'string' ? o : o.id;
        const text = typeof o === 'string' ? o : o.label;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            className="eg-seg-item"
            aria-checked={id === value}
            disabled={disabled}
            title={typeof o === 'string' ? undefined : o.title}
            onClick={() => onChange?.(id)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

export interface BannerProps {
  tone?: 'neutral' | 'warning' | 'danger';
  icon?: LucideIcon;
  title: React.ReactNode;
  text?: React.ReactNode;
  steps?: React.ReactNode[];
  actions?: React.ReactNode;
  className?: string;
}

export const Banner: React.FC<BannerProps> = ({ tone = 'neutral', icon, title, text, steps, actions, className }) => (
  <div className={cx('eg-banner', tone !== 'neutral' && `eg-banner-${tone}`, className)} role={tone !== 'neutral' ? 'status' : undefined}>
    <Icon icon={icon ?? (tone === 'warning' ? TriangleAlert : tone === 'danger' ? CircleX : Info)} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="eg-banner-title">{title}</div>
      {text && <div className="eg-banner-text">{text}</div>}
      {steps && (
        <ol className="eg-steps">
          {steps.map((s, i) => (
            <li key={i}>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      )}
      {actions && <div className="eg-banner-actions">{actions}</div>}
    </div>
  </div>
);

export const EmptyState: React.FC<{ icon?: LucideIcon; title: string; text?: React.ReactNode; actions?: React.ReactNode }> = ({
  icon = Inbox,
  title,
  text,
  actions,
}) => (
  <div className="eg-empty">
    <div className="eg-empty-icon">
      <Icon icon={icon} />
    </div>
    <div className="eg-empty-title">{title}</div>
    {text && <div className="eg-empty-text">{text}</div>}
    {actions && <div className="eg-empty-actions">{actions}</div>}
  </div>
);

export type RunStateKind = 'live' | 'queued' | 'review' | 'failed' | 'done' | 'waiting';

/** A task's run state, shown at the right edge of its line in the document. */
export const RunState: React.FC<{ state: RunStateKind; label: string; target?: string; meta?: string; title?: string }> = ({
  state,
  label,
  target,
  meta,
  title,
}) => {
  const cls = { live: 'eg-runstate-live', review: 'eg-runstate-review', failed: 'eg-runstate-failed', waiting: 'eg-runstate-review' }[
    state as 'live' | 'review' | 'failed' | 'waiting'
  ];
  const lead =
    state === 'live' ? (
      <StatusDot state="live" />
    ) : state === 'queued' ? (
      <StatusIcon status="queued" />
    ) : state === 'review' || state === 'waiting' ? (
      <StatusDot state="warning" />
    ) : state === 'failed' ? (
      <StatusDot state="danger" />
    ) : (
      <StatusDot state="success" />
    );
  return (
    <span className={cx('eg-runstate', cls)} title={title}>
      {lead}
      {label}
      {target && <code>{target}</code>}
      {meta && <span className="eg-runstate-meta">{meta}</span>}
    </span>
  );
};

export const RunRow: React.FC<{
  title: React.ReactNode;
  detail?: React.ReactNode;
  meta?: React.ReactNode;
  status?: DesignTaskStatus;
  live?: boolean;
  onClick?: () => void;
  active?: boolean;
}> = ({ title, detail, meta, status = 'done', live, onClick, active }) => {
  const body = (
    <>
      {live ? <StatusDot state="live" /> : <StatusIcon status={status} />}
      <div style={{ minWidth: 0 }}>
        <div className="eg-run-title" title={typeof title === 'string' ? title : undefined}>
          {title}
        </div>
        {detail && (
          <div className="eg-run-meta" title={typeof detail === 'string' ? detail : undefined}>
            {detail}
          </div>
        )}
      </div>
      <span className="eg-run-meta">{meta}</span>
    </>
  );
  return onClick ? (
    <button type="button" className={cx('eg-run', 'eg-run-btn', live && 'is-live', active && 'is-active')} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cx('eg-run', live && 'is-live')}>{body}</div>
  );
};

export interface ToastProps {
  tone?: Exclude<Tone, 'accent'>;
  title: string;
  text?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
}

export const ToastView: React.FC<ToastProps> = ({ tone = 'neutral', title, text, icon, actions }) => {
  const I = icon ?? { success: CircleCheck, warning: TriangleAlert, danger: CircleX, neutral: Info }[tone];
  return (
    <div className={cx('eg-toast', `eg-toast-${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="eg-toast-icon">
        <Icon icon={I} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="eg-toast-title">{title}</div>
        {text && <div className="eg-toast-text">{text}</div>}
      </div>
      {actions && <div className="eg-toast-actions">{actions}</div>}
    </div>
  );
};

/** Settings page building blocks (SettingsScreen): a titled group of rows. */
export const SettingsGroup: React.FC<{ title?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, children, className }) => (
  <section className={cx('eg-sgroup', className)}>
    {title && <h3 className="eg-sgroup-title">{title}</h3>}
    <div className="eg-srows">{children}</div>
  </section>
);

export const SettingsRow: React.FC<{ title: React.ReactNode; help?: React.ReactNode; children?: React.ReactNode; className?: string }> = ({
  title,
  help,
  children,
  className,
}) => (
  <div className={cx('eg-srow', className)}>
    <div className="eg-srow-text">
      <div className="eg-srow-title">{title}</div>
      {help && <div className="eg-srow-help">{help}</div>}
    </div>
    {children}
  </div>
);
