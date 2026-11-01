// Ergo component types — documentation for consumers. window.Ergo in previews; import from "@ergo/ui" in the app.
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, CSSProperties } from "react";

export type IconName = string; // Lucide icon name, e.g. "play", "terminal", "at-sign"
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
export type TaskStatus = "todo" | "queued" | "progress" | "review" | "done" | "failed";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface IconProps { name: IconName; size?: "md" | "sm"; className?: string; style?: CSSProperties }

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = the one main action in a view (Run, Approve). Default secondary. */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconRight?: IconName;
  /** Shortcut hint rendered as Kbd inside the button, e.g. "R" or ["⌘", "↵"]. */
  kbd?: string | string[];
  children?: ReactNode;
}
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: becomes aria-label and tooltip. */
  label: string;
  variant?: "ghost" | "secondary" | "primary" | "danger";
  size?: "sm" | "md";
}
export interface KbdProps { keys: string | string[] }

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: IconName;
  kbd?: string | string[];
  invalid?: boolean;
  /** Paths, commands, model IDs. */
  mono?: boolean;
}
export interface FieldProps { label?: string; help?: string; error?: string; children: ReactNode }
export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {}
export interface SwitchProps extends InputHTMLAttributes<HTMLInputElement> {}

export interface BadgeProps { tone?: Tone; outline?: boolean; icon?: IconName; children: ReactNode }
export interface StatusDotProps { state?: "idle" | "live" | "success" | "warning" | "danger"; label?: string }
export interface StatusIconProps { status: TaskStatus }
export interface PriorityIconProps { priority: Priority }

export interface AgentStatusProps {
  state?: "running" | "waiting" | "done" | "failed" | "idle";
  /** Agent name, shown in accent-text: "Claude Code", "Gemini CLI", "Local". */
  agent?: string;
  /** Present-tense verb phrase: "Editing", "Running tests in", "Waiting for approval on". */
  action: string;
  /** File, command or tool the action targets; rendered in mono. */
  target?: string;
  elapsed?: string;
  tokens?: string;
  onClick?: () => void;
}

export interface TabItem { id: string; label: string; count?: number; icon?: IconName }
export interface TabsProps { items: TabItem[]; value: string; onChange?: (id: string) => void }
export interface SegmentedControlProps { options: (string | { id: string; label: string })[]; value: string; onChange?: (id: string) => void; label?: string; full?: boolean }

export type MenuItem =
  | { label: string; icon?: IconName; hint?: string; danger?: boolean; checked?: boolean; active?: boolean; onSelect?: () => void }
  | { separator: true }
  | { section: string };
export interface MenuProps { items: MenuItem[]; style?: CSSProperties }

export interface DialogProps { title: string; description?: string; children: ReactNode; footer?: ReactNode; onClose?: (() => void) | false; width?: number; inline?: boolean }
export interface ToastProps { tone?: Exclude<Tone, "accent">; title: string; text?: string; icon?: IconName; actions?: ReactNode }

/** A task's run state, shown at the right edge of its line in the document. */
export interface RunStateProps {
  state: "live" | "queued" | "review" | "failed" | "done";
  /** "Editing", "Queued 2", "Review", "Failed", "Done 4m ago". */
  label: string;
  /** File or command, in mono: "Bullet.tsx". */
  target?: string;
  /** Elapsed time or other short meta: "2m 14s". */
  meta?: string;
}

/** One block of the TODO.md document. The text is the markdown the user typed, rendered inline and edited in place. */
export interface TaskLineProps {
  /** task = "- [ ] …", bullet = "- …", number = "1. …", text = a paragraph. Default task. */
  kind?: "task" | "bullet" | "number" | "text";
  /** Rendered inline markdown: text, <code>, <strong>, links, @file chips. Empty shows the placeholder. */
  children?: ReactNode;
  placeholder?: string;
  /** Nesting level from list indentation (0–4). */
  depth?: number;
  /** Checked task: "- [x] …". */
  done?: boolean;
  /** For kind="number". */
  num?: number;
  /** The line holding the caret; its task is the one shown in the detail pane. */
  current?: boolean;
  /** Part of a multi-line selection. */
  selected?: boolean;
  hasChildren?: boolean;
  collapsed?: boolean;
  /** How many lines are folded away when collapsed. */
  childCount?: number;
  run?: RunStateProps;
  /** Show Open brief / Run on hover and on the current line. Default true for tasks. */
  actions?: boolean;
}
export interface DocHeadingProps { level?: 1 | 2 | 3; count?: string; children: ReactNode }
export interface EditorToolbarProps {
  /** Icon names of the formats active at the caret, e.g. ["bold", "list-todo"]. */
  active?: string[];
  /** Block type at the caret: "Task", "Heading 2", "Text"… */
  block?: string;
  /** Content for the right end: document stats, view toggles. */
  right?: ReactNode;
}
export interface SelectionToolbarProps { draftLabel?: string; /** Tasks in the selection that can run. */ runCount?: number }

export type ComposerPart = string | { file: string } | { skill: string } | { caret: true };
export interface ComposerProps { parts?: ComposerPart[]; placeholder?: string; model?: string; submitLabel?: string; submitKbd?: string; primary?: boolean; readOnly?: boolean }

export interface TerminalLine { t: string; k?: "cmd" | "dim" | "ok" | "err" | "acc" | "ask" }
export interface TerminalProps { title?: string; lines: (string | TerminalLine)[]; live?: boolean; height?: number; actions?: ReactNode; prompt?: ReactNode }
export interface RunRowProps { title: string; detail?: string; meta?: string; status?: TaskStatus; live?: boolean }

export interface BannerProps { tone?: "neutral" | "warning"; icon?: IconName; title: string; text?: string; steps?: ReactNode[]; actions?: ReactNode }
export interface EmptyStateProps { icon?: IconName; title: string; text?: string; actions?: ReactNode }
export interface CodeBlockProps { code: string; lang?: string; file?: string }
