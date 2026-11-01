# Implementing the Ergo redesign

Instructions for Claude Code. This folder is the design system for Ergo's UI redesign. It changes the look and layout only; keep every existing feature working.

## Read first
1. `README.md` — the rules: color, type, spacing, motion, voice.
2. `simplification.md` — what to merge, hide or remove, and why.
3. `screens.md` — where each feature lives after the redesign.
4. `tokens.json` — every design value (colors per theme: dark first, then light).

## Reference implementation
- `components/bundle.css` — the stylesheet for every component (`eg-` classes), built only on CSS variables named after the tokens.
- `components/bundle.js` — plain-React reference components (`window.Ergo`). Port them to typed TSX; don't ship this file as is.
- `components/index.d.ts` — the props for each component.
- `components/<Name>/README.md` + `preview.html` — guidelines and a live example per component. The `*Screen` folders, `CommandPalette` and `NarrowWindow` are full-screen layouts to match.
- `fonts/` — Geist and Geist Mono (SIL OFL). Icons are Lucide (`lucide-react`).

## Suggested order
1. Turn `tokens.json` into CSS variables (`:root` / `[data-theme="dark"]` and `[data-theme="light"]`) plus Tailwind theme entries, and load the fonts.
2. Build the primitives: Button, Input, Kbd, Badge, StatusIcon, AgentStatus, Tabs, SegmentedControl, Menu, Dialog, Toast.
3. Restyle the HumanWorkspace document editor to match TaskLine and EditorToolbar. It stays a markdown document editor.
4. Rebuild the app frame (top bar, detail pane, status bar), then the screens one at a time.
5. Merge the modals into one Settings page, as `simplification.md` describes.

Keep the existing component names and state; map the new pieces onto them. Ask before deciding the open questions at the end of `simplification.md`.
