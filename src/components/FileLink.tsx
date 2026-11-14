/**
 * File paths as links that open in the user's editor at the line (Settings › Editor). `FileLinkText` linkifies plain
 * text (agent output, activity feed); MarkdownRenderer links prose and code spans through the same helpers.
 */
import React from 'react';
import { splitFileLinks, type FileRef } from '../lib/fileLinks';
import { describeFileRef, openFileRef } from '../lib/ideLinks';

function linkTitle(ref: FileRef): string {
  return `Open ${describeFileRef(ref)} in your editor`;
}

/** One file reference. `asCode` renders it as an inline code span. */
export const FileRefLink: React.FC<{
  fileRef: FileRef;
  asCode?: boolean;
  /** Overrides the default open (MarkdownRenderer's onOpenFile). */
  onOpen?: (ref: FileRef) => void;
  className?: string;
  children: React.ReactNode;
}> = ({ fileRef, asCode, onOpen, className, children }) => (
  <a
    href="#"
    className={`eg-filelink${asCode ? ' eg-filelink-code md-inline-code' : ''}${className ? ` ${className}` : ''}`}
    title={linkTitle(fileRef)}
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      if (onOpen) onOpen(fileRef);
      else void openFileRef(fileRef);
    }}
  >
    {children}
  </a>
);

/** Plain text with every file path in it linked. `inCode`: the text is code (bare file names are linked more freely). */
export const FileLinkText: React.FC<{ text: string; inCode?: boolean; onOpen?: (ref: FileRef) => void }> = ({ text, inCode, onOpen }) => {
  const parts = React.useMemo(() => splitFileLinks(text, { inCode }), [text, inCode]);
  if (parts.length === 1 && parts[0].kind === 'text') return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ) : (
          <FileRefLink key={i} fileRef={p.ref} onOpen={onOpen}>
            {p.text}
          </FileRefLink>
        ),
      )}
    </>
  );
};
