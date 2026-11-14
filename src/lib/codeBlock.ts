/**
 * Code blocks in the task editor: ``` (or ```ts, ```python, ...) then Space or Enter starts one; the language is kept
 * in the markdown fence (```ts) and drives syntax highlighting (lowlight / highlight.js, the common languages). Each
 * block has a header with a language picker, Convert to text, and an always-visible Copy button.
 *
 * Works inside tasks and sub-items: a task that would open with a code block keeps an (empty) title line above it
 * (TitledTasksExtension / preserveWhitespace.ts), since a task's done state is its struck title (taskDoneState.ts).
 */
import { Extension, textblockTypeInputRule } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { common, createLowlight } from 'lowlight';

export const lowlight = createLowlight(common);

/** The picker's languages: the id is what's written after ``` (short, as people type it). */
export const CODE_LANGUAGES: ReadonlyArray<{ id: string; label: string; aliases?: string[] }> = [
  { id: '', label: 'Plain text', aliases: ['text', 'txt', 'plaintext', 'plain'] },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'shell', 'zsh', 'console'] },
  { id: 'c', label: 'C', aliases: ['h'] },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'hpp', 'cxx'] },
  { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'] },
  { id: 'css', label: 'CSS' },
  { id: 'diff', label: 'Diff', aliases: ['patch'] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'graphql', label: 'GraphQL', aliases: ['gql'] },
  { id: 'html', label: 'HTML', aliases: ['xml', 'svg', 'xhtml'] },
  { id: 'java', label: 'Java' },
  { id: 'js', label: 'JavaScript', aliases: ['javascript', 'jsx', 'mjs', 'cjs'] },
  { id: 'json', label: 'JSON', aliases: ['jsonc', 'json5'] },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt'] },
  { id: 'lua', label: 'Lua' },
  { id: 'makefile', label: 'Makefile', aliases: ['make', 'mk'] },
  { id: 'markdown', label: 'Markdown', aliases: ['md'] },
  { id: 'php', label: 'PHP' },
  { id: 'python', label: 'Python', aliases: ['py'] },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'scss', label: 'SCSS', aliases: ['sass', 'less'] },
  { id: 'sql', label: 'SQL' },
  { id: 'swift', label: 'Swift' },
  { id: 'toml', label: 'TOML', aliases: ['ini'] },
  { id: 'ts', label: 'TypeScript', aliases: ['typescript', 'tsx', 'mts', 'cts'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
];

/** The picker entry for a block's language (an alias picks its language), or null for one not in the list. */
export function codeLanguageOption(language: string | null | undefined) {
  const lang = (language || '').trim().toLowerCase();
  return CODE_LANGUAGES.find((l) => l.id === lang || l.aliases?.includes(lang)) ?? null;
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const UNWRAP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V4h16v3"/><path d="M5 20h6"/><path d="M13 4 8 20"/><path d="m15 15 5 5"/><path d="m20 15-5 5"/></svg>';
const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (insecure context): the textarea fallback.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// ``` or ~~~ with an optional language (letters, digits, + # . -), then Space.
const BACKTICK_FENCE = /^```([a-z0-9+#.-]+)?[\s\n]$/i;
const TILDE_FENCE = /^~~~([a-z0-9+#.-]+)?[\s\n]$/i;
// The same typed alone on a line, then Enter.
const FENCE_LINE = /^(?:```|~~~)([a-z0-9+#.-]*)$/i;

const fenceLanguage = (lang: string | undefined) => (lang ? lang.toLowerCase() : null);

export const TaskCodeBlock = CodeBlockLowlight.extend({
  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: PMNode) {
          // In a task, the fence follows the line above directly (a fence may interrupt a paragraph). A blank line
          // there made the whole list "loose": every task got a blank line between it and the next on reload.
          if (state.inTightList) state.flushClose(1);
          // A fence longer than any backtick run inside the code, so ``` in the code can't close it early.
          const longest = Math.max(0, ...(node.textContent.match(/^\s*`{3,}/gm) ?? []).map((r) => r.trim().length));
          const fence = '`'.repeat(Math.max(3, longest + 1));
          state.write(fence + ((node.attrs.language as string | null) || '') + '\n');
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write(fence);
          state.closeBlock(node);
        },
      },
    };
  },

  addInputRules() {
    return [BACKTICK_FENCE, TILDE_FENCE].map((find) =>
      textblockTypeInputRule({ find, type: this.type, getAttributes: (m) => ({ language: fenceLanguage(m[1]) }) }),
    );
  },

  addNodeView() {
    return ({ node: initialNode, getPos, editor }) => {
      let node = initialNode as PMNode;

      const dom = document.createElement('div');
      dom.className = 'eg-code eg-codeblock';

      const head = document.createElement('div');
      head.className = 'eg-code-head eg-codeblock-head';
      head.contentEditable = 'false';

      // Language: a native select under a label, so it reads as the header's text, not a form control.
      const langWrap = document.createElement('label');
      langWrap.className = 'eg-codeblock-lang';
      langWrap.title = 'Language';
      const langText = document.createElement('span');
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Code language');
      const chevron = document.createElement('span');
      chevron.className = 'eg-codeblock-chevron';
      chevron.innerHTML = CHEVRON_ICON;
      langWrap.append(langText, chevron, select);

      const spacer = document.createElement('span');
      spacer.style.flex = '1';

      const iconButton = (icon: string, label: string) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eg-btn eg-btn-ghost eg-btn-icon eg-btn-sm eg-codeblock-btn';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.innerHTML = `<span class="eg-icon eg-icon-sm">${icon}</span>`;
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        return btn;
      };
      const unwrapBtn = iconButton(UNWRAP_ICON, 'Convert to text');
      unwrapBtn.classList.add('eg-codeblock-unwrap');
      const copyBtn = iconButton(COPY_ICON, 'Copy code');
      head.append(langWrap, spacer, unwrapBtn, copyBtn);

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.appendChild(code);
      dom.append(head, pre);

      let shownLanguage: string | null = null;
      const syncLanguage = () => {
        const language = (node.attrs.language as string | null) || '';
        select.disabled = !editor.isEditable;
        unwrapBtn.hidden = !editor.isEditable;
        if (language === shownLanguage) return;
        shownLanguage = language;
        const option = codeLanguageOption(language);
        const addOption = (label: string, value: string) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          select.appendChild(opt);
        };
        select.textContent = '';
        for (const l of CODE_LANGUAGES) addOption(l.label, l.id);
        // A language the list doesn't name (```elixir) stays as written.
        if (!option && language) addOption(language, language);
        select.value = option ? option.id : language;
        langText.textContent = option ? option.label : language;
        code.className = language ? `language-${language}` : '';
      };
      syncLanguage();

      select.addEventListener('change', () => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (typeof pos !== 'number') return;
        // Keep what was written when the choice is the same language (```typescript stays, not ```ts).
        const current = codeLanguageOption(node.attrs.language as string | null);
        if (current && current.id === select.value) return;
        editor.view.dispatch(editor.view.state.tr.setNodeAttribute(pos, 'language', select.value || null));
        editor.view.focus();
      });

      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ok = await copyText(node.textContent);
        if (!ok) return;
        copyBtn.innerHTML = `<span class="eg-icon eg-icon-sm">${CHECK_ICON}</span>`;
        copyBtn.title = 'Copied';
        copyBtn.classList.add('is-copied');
        window.setTimeout(() => {
          copyBtn.innerHTML = `<span class="eg-icon eg-icon-sm">${COPY_ICON}</span>`;
          copyBtn.title = 'Copy code';
          copyBtn.classList.remove('is-copied');
        }, 1500);
      });

      // Convert to text: one paragraph per line, where the block was.
      unwrapBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (typeof pos !== 'number') return;
        const { state } = editor.view;
        const { paragraph } = state.schema.nodes;
        const lines = node.textContent.split('\n');
        const paragraphs = lines.map((line) => paragraph.create(null, line ? state.schema.text(line) : null));
        const tr = state.tr.replaceWith(pos, pos + node.nodeSize, paragraphs);
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size))));
        editor.view.dispatch(tr);
        editor.view.focus();
      });

      return {
        dom,
        contentDOM: code,
        update(updated) {
          if (updated.type !== node.type) return false;
          node = updated as PMNode;
          syncLanguage();
          return true;
        },
        stopEvent(event) {
          return head.contains(event.target as Node);
        },
        ignoreMutation(mutation) {
          return head.contains(mutation.target as Node);
        },
      };
    };
  },
}).configure({ lowlight, defaultLanguage: null, languageClassPrefix: 'language-' });

/**
 * Keys in and into code blocks, ranked above the list keymaps (which act first otherwise):
 * - ``` (with an optional language) alone on a line, then Enter: the line becomes a code block.
 * - Enter inside a code block is a new line of code (in a task it split the task instead); the third Enter at the
 *   end still leaves the block.
 * - Tab / Shift-Tab inside a code block indent the line (in a task they nested or lifted the task instead).
 */
export const CodeFenceEnter = Extension.create({
  name: 'codeFenceEnter',
  priority: 1000,
  addKeyboardShortcuts() {
    const inCode = (editor: { state: { selection: { $from: { parent: PMNode } } } }) => !!editor.state.selection.$from.parent.type.spec.code;
    return {
      Tab: ({ editor }) => {
        if (!inCode(editor)) return false;
        const { state, view } = editor;
        view.dispatch(state.tr.insertText('  ', state.selection.from, state.selection.to));
        return true;
      },
      'Shift-Tab': ({ editor }) => {
        if (!inCode(editor)) return false;
        const { state, view } = editor;
        const { $from } = state.selection;
        const text = $from.parent.textContent;
        const lineStart = $from.parentOffset === 0 ? 0 : text.lastIndexOf('\n', $from.parentOffset - 1) + 1;
        const spaces = text.slice(lineStart).match(/^ {1,2}/)?.[0].length ?? 0;
        if (spaces) view.dispatch(state.tr.delete($from.start() + lineStart, $from.start() + lineStart + spaces));
        return true;
      },
      Enter: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        const { $from } = selection;
        const codeBlock = state.schema.nodes.codeBlock;
        if (inCode(editor)) {
          // Two blank lines at the end: let the code block's own Enter leave it.
          const atEnd = $from.parentOffset === $from.parent.content.size;
          if (selection.empty && atEnd && $from.parent.textContent.endsWith('\n\n')) return false;
          return editor.commands.newlineInCode();
        }
        if (!codeBlock || !selection.empty || !$from.parent.isTextblock) return false;
        if ($from.parentOffset !== $from.parent.content.size) return false;
        const m = $from.parent.textContent.match(FENCE_LINE);
        if (!m) return false;
        const start = $from.start();
        const tr = state.tr.delete(start, $from.end());
        tr.setBlockType(start, start, codeBlock, { language: fenceLanguage(m[1]) });
        tr.setSelection(TextSelection.create(tr.doc, start));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
});
