import React, { useCallback, useEffect } from 'react';
import { type TaskItem as TaskItemType } from '../types';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TiptapTaskList from '@tiptap/extension-task-list';
import TiptapTaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Plus } from 'lucide-react';

// Helper: insert a bullet subtask inside the listItem card at the given position
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertSubtaskAtCardPos(editorInstance: any, listItemPos: number) {
  if (!editorInstance) return;
  const { schema, doc } = editorInstance.state;
  const bulletList = schema.nodes.bulletList;
  const listItem = schema.nodes.listItem;
  const paragraph = schema.nodes.paragraph;
  if (!bulletList || !listItem || !paragraph) return;

  // Read the LIVE listItem node from the current doc
  const liveNode = doc.nodeAt(listItemPos);
  if (!liveNode || liveNode.type.name !== 'listItem') return;

  // Scan children: find where paragraph ends and if a bulletList already exists
  let insertAfterParagraph = listItemPos + 1;
  let existingBulletEnd: number | null = null;

  liveNode.forEach((child: any, offset: number) => {
    if (child.type.name === 'paragraph') {
      insertAfterParagraph = listItemPos + 1 + offset + child.nodeSize;
    }
    if (child.type.name === 'bulletList') {
      // Position just before the bulletList closing tag — insert new items here
      existingBulletEnd = listItemPos + 1 + offset + child.nodeSize - 1;
    }
  });

  const tr = editorInstance.state.tr;
  let focusPos: number;

  if (existingBulletEnd !== null) {
    // Append another bullet item to the existing nested list
    const newItem = listItem.create(null, paragraph.create(null));
    tr.insert(existingBulletEnd, newItem);
    focusPos = existingBulletEnd + 2;
  } else {
    // Create a fresh bulletList with one empty item, placed right after the paragraph
    const newBullet = bulletList.create(null, listItem.create(null, paragraph.create(null)));
    tr.insert(insertAfterParagraph, newBullet);
    focusPos = insertAfterParagraph + 3;
  }

  const clampedPos = Math.min(focusPos, tr.doc.content.size - 1);
  tr.setSelection(editorInstance.state.selection.constructor.near(tr.doc.resolve(clampedPos)));
  editorInstance.view.dispatch(tr);
  editorInstance.view.focus();
}

// Extension: H1 → ordered list on Enter; Shift+Enter inside card → add subtask
const AutoCardListExtension = Extension.create({
  name: 'autoCardList',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (editor.isActive('heading', { level: 1 })) {
          const { $from } = editor.state.selection;
          if ($from.parentOffset === $from.parent.content.size) {
            return editor.chain().splitBlock().toggleOrderedList().run();
          }
        }
        return false;
      },
      'Shift-Enter': ({ editor }) => {
        // When inside an ordered list card, Shift+Enter adds a subtask bullet
        if (!editor.isActive('orderedList')) return false;
        const { $from } = editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name === 'listItem') {
            const parentNode = $from.node(depth - 1);
            if (parentNode.type.name === 'orderedList') {
              insertSubtaskAtCardPos(editor, $from.before(depth));
              return true;
            }
            break;
          }
        }
        return false;
      },
    };
  },
});

// Decoration plugin: renders an "Add Subtask" button on every top-level ordered-list card
const CardSubtaskDecorationExtension = Extension.create({
  name: 'cardSubtaskDecoration',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('cardSubtaskDecorationPlugin'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const { doc } = state;

            doc.descendants((node, pos) => {
              if (node.type.name !== 'listItem') return;
              const resolved = doc.resolve(pos);
              const parent = resolved.parent;
              if (parent.type.name !== 'orderedList') return;
              // Skip nested listItems (subtask bullets already inside a card)
              if (resolved.depth >= 2) {
                const grandParent = resolved.node(resolved.depth - 2);
                if (grandParent && grandParent.type.name === 'listItem') return;
              }

              // Place widget at pos+1 (inside the listItem). Remember that
              // getPos() will return this pos+1 value, so the click handler
              // must subtract 1 to get the actual listItem position.
              const widget = Decoration.widget(
                pos + 1,
                (_view, getPos) => {
                  const btn = document.createElement('button');
                  btn.className = 'card-add-subtask-btn';
                  btn.setAttribute('contenteditable', 'false');
                  btn.type = 'button';
                  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span>Add Subtask</span>`;

                  btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const widgetPos = typeof getPos === 'function' ? getPos() : pos + 1;
                    if (widgetPos == null) return;
                    // Widget is at pos+1 (inside listItem), so subtract 1
                    // to get the actual listItem node position
                    const listItemPos = widgetPos - 1;
                    insertSubtaskAtCardPos(editor, listItemPos);
                  });

                  return btn;
                },
                { side: -1 }
              );
              decorations.push(widget);
            });

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});

import {
  FileText,
  Sparkles,
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  FileCode,
  Quote,
  Minus,
  Link as LinkIcon,
  Undo2,
  Redo2,
} from 'lucide-react';

interface TaskPaneProps {
  rawMarkdown: string;
  tasks: TaskItemType[];
  onOpenDraftModal: () => void;
  onMarkdownChange: (newMarkdown: string) => void;
}

// ── Toolbar button component ────────────────────────────────────
interface ToolbarBtnProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}

const ToolbarBtn: React.FC<ToolbarBtnProps> = ({ onClick, active, disabled, title, children }) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={onClick}
    className={`tiptap-toolbar-btn ${active ? 'is-active' : ''}`}
  >
    {children}
  </button>
);

// ── Toolbar separator ───────────────────────────────────────────
const Sep = () => <div className="tiptap-toolbar-sep" />;

// ── Main component ──────────────────────────────────────────────
export const TaskPane: React.FC<TaskPaneProps> = ({
  rawMarkdown,
  tasks,
  onOpenDraftModal,
  onMarkdownChange,
}) => {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Strike is included; disable heading keyboard shortcut interference
        heading: { levels: [1, 2, 3, 4] },
        code: {},
        codeBlock: {},
        blockquote: {},
        horizontalRule: {},
      }),
      Placeholder.configure({
        placeholder: '# My Task List\n\nStart typing in markdown — **bold**, *italic*, `code`, headings, lists…',
      }),
      TiptapTaskList,
      TiptapTaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false }),
      Typography,
      AutoCardListExtension,
      CardSubtaskDecorationExtension,
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: rawMarkdown,
    autofocus: false,
    onUpdate({ editor }) {
      // Serialize back to markdown on every change
      const md = (editor as unknown as WithMarkdownStorage).storage.markdown.getMarkdown();
      onMarkdownChange(md);
    },
  });

  // Sync content if the project changes externally
  useEffect(() => {
    if (!editor) return;
    const current = (editor as unknown as WithMarkdownStorage).storage.markdown.getMarkdown();
    // Only reset if content meaningfully diverges (avoids caret jump on every keystroke)
    if (current.trim() !== rawMarkdown.trim()) {
      editor.commands.setContent(rawMarkdown);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawMarkdown, editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Enter URL', prev ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }, [editor]);

  const doneTasks = tasks.filter((t) => t.isDone).length;

  return (
    <div className="pane pane-left obsidian-pane">
      {/* ── Header ── */}
      <div className="pane-header obsidian-header">
        <div className="pane-title">
          <FileText size={17} color="var(--accent-cyan)" />
          <span>TODO.md</span>
          <span className="pane-subtitle">{doneTasks}/{tasks.length} done</span>
        </div>
        <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
            onClick={onOpenDraftModal}
          >
            <Sparkles size={13} />
            <span>Draft with AI</span>
          </button>
        </div>
      </div>

      {/* ── Formatting Toolbar ── */}
      <div className="tiptap-toolbar">
        {/* History */}
        <ToolbarBtn title="Undo" onClick={() => editor?.chain().focus().undo().run()} disabled={!editor?.can().undo()}>
          <Undo2 size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Redo" onClick={() => editor?.chain().focus().redo().run()} disabled={!editor?.can().redo()}>
          <Redo2 size={14} />
        </ToolbarBtn>

        <Sep />

        {/* Text styles */}
        <ToolbarBtn title="Bold (Ctrl+B)" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()}>
          <Bold size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Italic (Ctrl+I)" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <Italic size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Strikethrough" active={editor?.isActive('strike')} onClick={() => editor?.chain().focus().toggleStrike().run()}>
          <Strikethrough size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Inline Code" active={editor?.isActive('code')} onClick={() => editor?.chain().focus().toggleCode().run()}>
          <Code size={14} />
        </ToolbarBtn>

        <Sep />

        {/* Headings */}
        <ToolbarBtn title="Heading 1" active={editor?.isActive('heading', { level: 1 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 2" active={editor?.isActive('heading', { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 3" active={editor?.isActive('heading', { level: 3 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>
          <Heading3 size={14} />
        </ToolbarBtn>

        <Sep />

        {/* Lists */}
        <ToolbarBtn title="Bullet List" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          <List size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Numbered List" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          <ListOrdered size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Task / Checklist" active={editor?.isActive('taskList')} onClick={() => editor?.chain().focus().toggleTaskList().run()}>
          <CheckSquare size={14} />
        </ToolbarBtn>

        <Sep />

        {/* Block elements */}
        <ToolbarBtn title="Blockquote" active={editor?.isActive('blockquote')} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
          <Quote size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Code Block" active={editor?.isActive('codeBlock')} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
          <FileCode size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Horizontal Rule" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>
          <Minus size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Link" active={editor?.isActive('link')} onClick={setLink}>
          <LinkIcon size={14} />
        </ToolbarBtn>
      </div>

      {/* ── Editor canvas ── */}
      <div className="obsidian-body tiptap-body" style={{ position: 'relative' }}>
        <EditorContent editor={editor} className="tiptap-editor-root" />
        <div style={{ padding: '0 2.25rem 1.75rem' }}>
          <button
            type="button"
            className="new-card-btn"
            onClick={() => {
              if (!editor) return;
              if (editor.isActive('orderedList')) {
                editor.chain().focus().splitListItem('listItem').run();
              } else {
                editor.chain().focus().toggleOrderedList().run();
              }
            }}
          >
            <Plus size={15} />
            <span>New Card</span>
          </button>
        </div>
      </div>
    </div>
  );
};
