/**
 * The document schema and markdown round-trip shared by every task editor: the lane editor (TaskPane.tsx) and the
 * board's card editor (TaskCardModal.tsx). Both edit the same markdown, so both must read and write it the same way —
 * add a node or mark here, not in one editor only. Behavior that belongs to one editor (decorations, keymaps,
 * autocomplete) stays with that editor.
 */
import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Strike from '@tiptap/extension-strike';
import CodeMark from '@tiptap/extension-code';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { AnchoredListItem } from './listItemAnchor';
import { ColorHeading } from './headingColorNode';
import { Highlight, MarkdownUnderline } from './delimitedMarks';
import { TextColor } from './textColorMark';
import { LineSpacingParagraph } from './lineSpacingMark';
import { CodeFenceEnter, TaskCodeBlock } from './codeBlock';

// A checked-off task is struck through as a whole, so strikethrough ranks outside every other mark. Ranked inside bold
// (StarterKit's order) it was closed around bold words, "~~one ~~**~~two~~** ~~three~~", which markdown can't read
// back: each save turned more of a checked-off task into literal, then escaped, tildes.
const OuterStrike = Strike.extend({ priority: 1000 });

// Inline code takes no other formatting, except strikethrough: a task with `code` in it has to be struck through as a
// whole to count as checked off (it never could be with code's default "excludes everything").
const StrikeableCode = CodeMark.extend({ excludes: 'bold italic underline highlight textColor link' });

// An image is a block of its own (a screenshot on its own line). Written with markdown's inline image serializer it
// didn't close its block, so a paragraph after it was glued onto the same line (`![shot](…)More text`).
const BlockImage = Image.extend({
  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          const src = String(node.attrs.src || '').replace(/[()]/g, '\\$&');
          const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
          state.write(`![${state.esc(node.attrs.alt || '')}](${src}${title})`);
          state.closeBlock(node);
        },
      },
    };
  },
});

export interface TaskEditorExtensionOptions {
  /** Placeholder text for an empty line (headings get "Heading..."). */
  placeholder: string;
}

/** The extensions that define a task document and its markdown, in the order the lane editor has always used. */
export function taskEditorExtensions({ placeholder }: TaskEditorExtensionOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      paragraph: false,
      heading: false,
      underline: false,
      strike: false,
      code: false,
      // Code blocks are TaskCodeBlock below: highlighted, with a language picker and a copy button (codeBlock.ts).
      codeBlock: false,
      // StarterKit 3 bundles Link; the configured Link below (no open on click, md-link class) is the only one.
      link: false,
      bulletList: { keepMarks: true, keepAttributes: false },
      orderedList: { keepMarks: true, keepAttributes: false },
      listItem: false,
    }),
    // List items carry their task's hidden anchor (listItemAnchor.ts), so briefs stay with a line as it moves.
    AnchoredListItem,
    OuterStrike,
    StrikeableCode,
    TaskCodeBlock,
    CodeFenceEnter,
    ColorHeading,
    MarkdownUnderline,
    Highlight,
    Link.configure({
      openOnClick: false,
      HTMLAttributes: { class: 'md-link', target: '_blank', rel: 'noopener noreferrer' },
    }),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading...' : placeholder),
    }),
    Typography,
    TextColor,
    LineSpacingParagraph,
    BlockImage.configure({
      inline: false,
      allowBase64: true,
      HTMLAttributes: {
        class: 'task-attached-image',
      },
    }),
    Markdown.configure({
      html: false,
      tightLists: true,
      tightListClass: 'tight',
      bulletListMarker: '-',
      linkify: true,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
  ];
}
