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
  FileCode,
  Quote,
  Link,
  Table,
  Minus
} from 'lucide-react';

interface RichTextToolbarProps {
  onInsertSyntax?: (prefix: string, suffix?: string, placeholder?: string) => void;
  targetRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  compact?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

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
      input.value = newValue;

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

  const toolbarButtons = [
    { label: 'Bold', icon: Bold, prefix: '**', suffix: '**', placeholder: 'bold text', tooltip: 'Bold (**text**)' },
    { label: 'Italic', icon: Italic, prefix: '*', suffix: '*', placeholder: 'italic text', tooltip: 'Italic (*text*)' },
    { label: 'Strikethrough', icon: Strikethrough, prefix: '~~', suffix: '~~', placeholder: 'strikethrough text', tooltip: 'Strikethrough (~~text~~)' },
    { divider: true },
    { label: 'Heading 1', icon: Heading1, prefix: '# ', suffix: '', placeholder: 'Heading 1', tooltip: 'Heading 1 (# Title)' },
    { label: 'Heading 2', icon: Heading2, prefix: '## ', suffix: '', placeholder: 'Heading 2', tooltip: 'Heading 2 (## Title)' },
    { label: 'Heading 3', icon: Heading3, prefix: '### ', suffix: '', placeholder: 'Heading 3', tooltip: 'Heading 3 (### Title)' },
    { divider: true },
    { label: 'Bullet List', icon: List, prefix: '- ', suffix: '', placeholder: 'List item', tooltip: 'Bullet List (- item)' },
    { label: 'Numbered List', icon: ListOrdered, prefix: '1. ', suffix: '', placeholder: 'Numbered item', tooltip: 'Numbered List (1. item)' },
    { divider: true },
    { label: 'Inline Code', icon: Code, prefix: '`', suffix: '`', placeholder: 'code', tooltip: 'Inline Code (`code`)' },
    { label: 'Code Block', icon: FileCode, prefix: '```\n', suffix: '\n```', placeholder: 'code block content', tooltip: 'Code Block (```)' },
    { label: 'Quote', icon: Quote, prefix: '> ', suffix: '', placeholder: 'Quote text', tooltip: 'Blockquote (> quote)' },
    { divider: true },
    { label: 'Link', icon: Link, prefix: '[', suffix: '](https://example.com)', placeholder: 'link text', tooltip: 'Hyperlink ([text](url))' },
    { label: 'Table', icon: Table, prefix: '| Header 1 | Header 2 |\n| --- | --- |\n| ', suffix: ' | Cell 2 |', placeholder: 'Cell 1', tooltip: 'Markdown Table' },
    { label: 'Horizontal Line', icon: Minus, prefix: '\n---\n', suffix: '', placeholder: '', tooltip: 'Horizontal Rule (---)' },
  ];

  return (
    <div
      className={`rich-text-toolbar ${className}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? '0.2rem' : '0.35rem',
        background: 'rgba(13, 18, 31, 0.95)',
        overflowX: 'auto',
        maxWidth: '100%',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        ...style
      }}
    >
      {toolbarButtons.map((btn, idx) => {
        if ('divider' in btn) {
          return (
            <div
              key={`div-${idx}`}
              style={{
                width: '1px',
                height: '16px',
                background: 'var(--border-subtle)',
                margin: '0 0.15rem'
              }}
            />
          );
        }

        const IconComponent = btn.icon;
        return (
          <button
            key={btn.label}
            type="button"
            className="toolbar-btn"
            title={btn.tooltip}
            onClick={() => applyFormatting(btn.prefix, btn.suffix, btn.placeholder)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: compact ? '26px' : '28px',
              height: compact ? '26px' : '28px',
              borderRadius: '4px',
              border: '1px solid transparent',
              background: 'rgba(255, 255, 255, 0.04)',
              color: 'var(--text-main)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              padding: 0
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--accent-primary)';
              e.currentTarget.style.color = '#fff';
              e.currentTarget.style.borderColor = 'var(--accent-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
              e.currentTarget.style.color = 'var(--text-main)';
              e.currentTarget.style.borderColor = 'transparent';
            }}
          >
            <IconComponent size={compact ? 13 : 14} />
          </button>
        );
      })}
    </div>
  );
};
