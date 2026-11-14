import React from 'react';
import {
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Code,
  SquareCode,
  Quote,
  Link,
  Table,
  Minus,
  type LucideIcon,
} from 'lucide-react';

interface RichTextToolbarProps {
  onInsertSyntax?: (prefix: string, suffix?: string, placeholder?: string) => void;
  targetRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  /** Smaller buttons (no longer changes colors: the toolbar follows the theme either way). */
  compact?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

type ToolbarItem =
  | { divider: true }
  | { label: string; icon: LucideIcon; prefix: string; suffix: string; placeholder: string; tooltip: string };

const TOOLBAR_ITEMS: ToolbarItem[] = [
  { label: 'Bold', icon: Bold, prefix: '**', suffix: '**', placeholder: 'bold text', tooltip: 'Bold (**text**)' },
  { label: 'Italic', icon: Italic, prefix: '*', suffix: '*', placeholder: 'italic text', tooltip: 'Italic (*text*)' },
  { label: 'Strikethrough', icon: Strikethrough, prefix: '~~', suffix: '~~', placeholder: 'strikethrough text', tooltip: 'Strikethrough (~~text~~)' },
  { divider: true },
  { label: 'Heading 1', icon: Heading1, prefix: '# ', suffix: '', placeholder: 'Heading 1', tooltip: 'Heading 1 (# Title)' },
  { label: 'Heading 2', icon: Heading2, prefix: '## ', suffix: '', placeholder: 'Heading 2', tooltip: 'Heading 2 (## Title)' },
  { label: 'Heading 3', icon: Heading3, prefix: '### ', suffix: '', placeholder: 'Heading 3', tooltip: 'Heading 3 (### Title)' },
  { divider: true },
  { label: 'Bullet list', icon: List, prefix: '- ', suffix: '', placeholder: 'List item', tooltip: 'Bullet list (- item)' },
  { label: 'Numbered list', icon: ListOrdered, prefix: '1. ', suffix: '', placeholder: 'Numbered item', tooltip: 'Numbered list (1. item)' },
  { divider: true },
  { label: 'Inline code', icon: Code, prefix: '`', suffix: '`', placeholder: 'code', tooltip: 'Inline code (`code`)' },
  { label: 'Code block', icon: SquareCode, prefix: '```\n', suffix: '\n```', placeholder: 'code block content', tooltip: 'Code block (```)' },
  { label: 'Quote', icon: Quote, prefix: '> ', suffix: '', placeholder: 'Quote text', tooltip: 'Quote (> quote)' },
  { divider: true },
  { label: 'Link', icon: Link, prefix: '[', suffix: '](https://example.com)', placeholder: 'link text', tooltip: 'Link ([text](url))' },
  { label: 'Table', icon: Table, prefix: '| Header 1 | Header 2 |\n| --- | --- |\n| ', suffix: ' | Cell 2 |', placeholder: 'Cell 1', tooltip: 'Table' },
  { label: 'Horizontal line', icon: Minus, prefix: '\n---\n', suffix: '', placeholder: '', tooltip: 'Horizontal line (---)' },
];

/** Sets a controlled input's value so React's onChange sees it (a plain `.value =` is swallowed by React's tracker). */
function setNativeValue(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

/**
 * Markdown formatting bar for the AI workspace's brief/notes textareas. Styled like the human-side document toolbar
 * (.eg-toolbar / .eg-tb-btn / .eg-tb-sep), so it follows the light and dark themes.
 */
export const RichTextToolbar: React.FC<RichTextToolbarProps> = ({
  onInsertSyntax,
  targetRef,
  compact = false,
  className = '',
  style
}) => {

  const applyFormatting = (prefix: string, suffix: string = '', placeholder: string = 'text') => {
    if (onInsertSyntax) {
      onInsertSyntax(prefix, suffix, placeholder);
      return;
    }

    if (targetRef && targetRef.current) {
      const input = targetRef.current;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const selectedText = input.value.substring(start, end);
      const textToInsert = selectedText || placeholder;
      const replacement = `${prefix}${textToInsert}${suffix}`;

      // Insert at cursor
      const newValue = input.value.substring(0, start) + replacement + input.value.substring(end);
      setNativeValue(input, newValue);

      // Trigger change event if React state listener exists
      const event = new Event('input', { bubbles: true });
      input.dispatchEvent(event);

      // Set selection back
      input.focus();
      const newCursorStart = start + prefix.length;
      const newCursorEnd = newCursorStart + textToInsert.length;
      input.setSelectionRange(newCursorStart, newCursorEnd);
    }
  };

  return (
    <div
      className={`eg-toolbar eg-md-toolbar${compact ? ' is-compact' : ''} ${className}`.trim()}
      role="toolbar"
      aria-label="Formatting"
      style={style}
    >
      {TOOLBAR_ITEMS.map((btn, idx) => {
        if ('divider' in btn) {
          return <span key={`div-${idx}`} className="eg-tb-sep" aria-hidden="true" />;
        }
        const IconComponent = btn.icon;
        return (
          <button
            key={btn.label}
            type="button"
            className="eg-tb-btn"
            title={btn.tooltip}
            aria-label={btn.label}
            // Keep the caret/selection in the textarea being formatted.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyFormatting(btn.prefix, btn.suffix, btn.placeholder)}
          >
            <span className="eg-icon" aria-hidden="true">
              <IconComponent strokeWidth={1.75} />
            </span>
          </button>
        );
      })}
    </div>
  );
};
