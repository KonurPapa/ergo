import React from 'react';

export type StageBarState = 'not_started' | 'working' | 'done';

export interface StageBarItem<T extends string> {
  id: T;
  label: string;
  /** How far the run got: done stages are filled in ink, the working one fills as it runs. */
  state: StageBarState;
  count?: number;
  /** Small trailing marker (an alert or live dot). */
  marker?: React.ReactNode;
  /** Not reached yet: greyed out and can't be selected. */
  disabled?: boolean;
  title?: string;
}

/**
 * The detail pane's stage tabs as progress bars (like the onboarding steps): the run's progress fills the bars in ink
 * (done stages full, the working one animating), and the stage being viewed is green. Viewing never affects the run.
 */
export function TaskStageBars<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: StageBarItem<T>[];
  /** The stage being viewed. */
  value: T;
  onChange?: (id: T) => void;
  label?: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const enabled = items.filter((t) => !t.disabled);
    const at = enabled.findIndex((t) => t.id === value);
    if (at === -1) return;
    const next = enabled[(at + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
    if (next) {
      e.preventDefault();
      onChange?.(next.id);
      const btn = e.currentTarget.querySelector<HTMLButtonElement>(`[data-stage="${next.id}"]`);
      btn?.focus();
    }
  };
  return (
    <div
      className="eg-stagebars"
      role="tablist"
      aria-label={label}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      onKeyDown={onKeyDown}
    >
      {items.map((t) => {
        const viewed = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-stage={t.id}
            className={`eg-stagebar is-${t.state.replace('_', '-')}${viewed ? ' is-viewed' : ''}`}
            aria-selected={viewed}
            tabIndex={viewed ? 0 : -1}
            disabled={t.disabled}
            title={t.title}
            onClick={() => !t.disabled && onChange?.(t.id)}
          >
            <span className="eg-stagebar-track" aria-hidden="true">
              <i />
            </span>
            <span className="eg-stagebar-label">
              {t.label}
              {t.count != null && <span className="eg-count">{t.count}</span>}
              {t.marker}
            </span>
          </button>
        );
      })}
    </div>
  );
}
