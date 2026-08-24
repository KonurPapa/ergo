import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, CheckSquare, Square, FileCode } from 'lucide-react';
import { openFileInIdeOrSystem } from '../lib/mcpClient';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  inline?: boolean;
  onOpenFile?: (path: string) => void;
}

/**
 * Rich Markdown Renderer powered by react-markdown and remark-gfm.
 * Translates raw Markdown syntax into stylized UI elements throughout Ergo.
 */
export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className = '',
  style,
  inline = false,
  onOpenFile
}) => {
  if (!content) return null;

  return (
    <div
      className={`markdown-styled-content ${inline ? 'inline-mode' : ''} ${className}`}
      style={style}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings
          h1: ({ children }) => (
            <h1 className="md-h1">
              <span className="md-heading-symbol">#</span> {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="md-h2">
              <span className="md-heading-symbol">##</span> {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="md-h3">
              <span className="md-heading-symbol">###</span> {children}
            </h3>
          ),
          h4: ({ children }) => <h4 className="md-h4">{children}</h4>,

          // Text formatting
          strong: ({ children }) => <strong className="md-strong">{children}</strong>,
          em: ({ children }) => <em className="md-em">{children}</em>,
          del: ({ children }) => <del className="md-del">{children}</del>,

          // Links
          a: ({ href, children }) => {
            const isLocalFile = href && (
              href.startsWith('file://') ||
              href.startsWith('projects/') ||
              href.startsWith('.ergo/') ||
              href.startsWith('~/') ||
              href.startsWith('./') ||
              /\.(ts|tsx|js|jsx|json|py|rs|go|c|cpp|h|css|html|md|toml|yaml|yml|sh|sql)$/i.test(href)
            );

            const isExternalWeb = href && (href.startsWith('http://') || href.startsWith('https://'));

            const handleClick = async (e: React.MouseEvent) => {
              e.stopPropagation();
              if (isLocalFile && !isExternalWeb) {
                e.preventDefault();
                if (onOpenFile) {
                  onOpenFile(href);
                } else {
                  await openFileInIdeOrSystem(href);
                }
              }
            };

            return (
              <a
                href={href}
                target={isExternalWeb ? '_blank' : undefined}
                rel={isExternalWeb ? 'noopener noreferrer' : undefined}
                className={`md-link ${isLocalFile ? 'md-file-link' : ''}`}
                onClick={handleClick}
                title={isLocalFile ? `Open ${href} in IDE / Editor` : undefined}
              >
                {isLocalFile && <FileCode size={12} className="md-file-icon" />}
                <span>{children}</span>
                {isExternalWeb ? (
                  <ExternalLink size={11} style={{ opacity: 0.7 }} />
                ) : isLocalFile ? (
                  <span className="md-ide-tag">IDE</span>
                ) : null}
              </a>
            );
          },

          // Code blocks & inline code
          code: ({ className: codeClassName, children, ...props }) => {
            const isCodeBlock = codeClassName && codeClassName.includes('language-');
            const codeString = String(children).replace(/\n$/, '');

            if (isCodeBlock) {
              const lang = codeClassName ? codeClassName.replace('language-', '') : '';
              return (
                <div className="md-code-block-wrapper">
                  <div className="md-code-block-header">
                    <span className="md-code-lang">{lang || 'code'}</span>
                  </div>
                  <pre className="md-pre">
                    <code className="md-code-block">{codeString}</code>
                  </pre>
                </div>
              );
            }

            return <code className="md-inline-code" {...props}>{children}</code>;
          },

          // Blockquotes
          blockquote: ({ children }) => (
            <blockquote className="md-blockquote">
              <div className="md-blockquote-bar" />
              <div className="md-blockquote-content">{children}</div>
            </blockquote>
          ),

          // Lists
          ul: ({ children }) => <ul className="md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="md-ol">{children}</ol>,
          li: ({ children }) => <li className="md-li">{children}</li>,

          // Tables
          table: ({ children }) => (
            <div className="md-table-wrapper">
              <table className="md-table">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="md-thead">{children}</thead>,
          tbody: ({ children }) => <tbody className="md-tbody">{children}</tbody>,
          tr: ({ children }) => <tr className="md-tr">{children}</tr>,
          th: ({ children }) => <th className="md-th">{children}</th>,
          td: ({ children }) => <td className="md-td">{children}</td>,

          // Divider
          hr: () => <hr className="md-hr" />,

          // Checkboxes
          input: ({ type, checked }) => {
            if (type === 'checkbox') {
              return (
                <span className="md-checkbox-icon">
                  {checked ? (
                    <CheckSquare size={14} color="var(--accent-emerald)" />
                  ) : (
                    <Square size={14} color="var(--text-dim)" />
                  )}
                </span>
              );
            }
            return <input type={type} checked={checked} readOnly />;
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
