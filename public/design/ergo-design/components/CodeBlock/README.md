# CodeBlock

Markdown and code rendering for briefs, notes and completion records. Wrap rendered markdown in `.eg-md`; fenced code renders as `CodeBlock`.

**Consumer provides:** `code`, `lang` or `file` (shown in the header), and the markdown renderer's output inside `.eg-md`.

- Brief text in `body-lg` (`ink-muted`), headings in `ink`: h1 `title-lg`, h2 `title`, h3 `body-strong`. Links `accent-text`. Inline code on `surface-3` in mono.
- Code blocks: `canvas` well, hairline edge, `radius-md`, a 28px header with the file path and a copy button. Syntax colors stay inside the palette: keywords `accent-text`, strings `success`, comments `ink-subtle`; diff lines `success` / `danger`.
- Long lines scroll horizontally; never wrap code.
