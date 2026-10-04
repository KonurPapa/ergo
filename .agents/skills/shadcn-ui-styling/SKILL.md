---
name: shadcn-ui-styling
description: >-
  Design system and UI/UX styling guidelines for building and editing modern Kiro Crew & ShadCN-inspired
  interfaces in the application. Use whenever creating, styling, formatting, or updating UI
  components, cards, buttons, lists, chips, tables, modals, sidebars, tabs, or menus.
---

# Kiro Crew & ShadCN Design System & UI Guidelines

This skill provides the comprehensive styling, layout, and component architecture rules to ensure that every new or modified UI element adheres to a clean, cohesive, and premium dark aesthetic matching **Kiro Crew**.

---

## 1. Core Color Palette & Theme Tokens

Base all UI components on this dark-mode color foundation (mirroring Kiro Crew's exact design tokens):

Token Name | Hex / CSS Value | Description / Usage
:--- | :--- | :---
**Canvas Background** | `#12141a` / `var(--bg-canvas)` | Outermost window background, track areas, page base.
**Elevated Pane Surface** | `#1a1d25` / `var(--bg-pane)` | Elevated surface for panels, vertical swimlane columns, and navigation bar.
**Card Surface** | `#181b22` / `var(--card-bg)` | Individual task cards, modal bodies, dropdown menus, and popovers.
**Card Hover / Secondary Surface** | `#262a35` / `var(--card-hover)` | Active card hover states, selected items, table row highlights.
**Hairline Borders** | `#27272a` / `var(--border-subtle)` | Clean hairline borders for cards, buttons, separators, and inputs (Zinc-800).
**Strong Borders** | `#3f3f46` / `var(--border-strong)` | Focused controls, active tabs, header dividers (Zinc-700).
**Primary Action Accent** | `#2563eb` / `var(--accent-primary)` | Primary action buttons, AI selectors, focus rings (Blue-600).
**Mint Accent** | `#00d492` / `var(--accent)` | Active swimlane glow, card selection indicator, execute/run buttons, terminal cursor.
**Cyan Accent** | `#06b6d4` / `var(--accent-cyan)` | Live running states, active agent indicators, terminal accents.
**Warning Status** | `#eab308` / `var(--warning)` | Warning badges, standby status, archive action indicators.
**Destructive / Danger** | `#ef4444` / `var(--danger)` | Destructive/danger buttons, remove actions, error badges.
**Text Bright** | `#fafafa` / `var(--text-bright)` | Primary titles, active buttons, headings.
**Text Main** | `#e4e4e7` / `var(--text-main)` | Body text, labels, button text.
**Text Muted** | `#71717a` / `var(--text-muted)` | Secondary descriptions, timestamps, count badges, column headers.

---

## 2. Typography

Kiro Crew's typography pairing:
- **UI / Sans Font**: Space Grotesk (`'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`)
- **Code / Mono Font**: JetBrains Mono (`'JetBrains Mono', ui-monospace, SFMono-Regular, monospace`)

Usage rules:
- App headers, brand labels, modal titles, and section headers use `Space Grotesk` with `letter-spacing: -0.01em` or `-0.02em`.
- Status badges, prompts, code snippets, file paths, and terminal outputs use `JetBrains Mono`.

---

## 3. Layout & Spacing Architecture

### Panel & Column Layouts
- **Padding & Gaps**: Use consistent `0.55rem` to `0.75rem` outer padding between panes and columns.
- **Card Containers**:
  - `border-radius: 8px;` (10px - 12px for outer swimlane panels).
  - `border: 1px solid var(--border-subtle);` (`#27272a`)
  - `background: var(--card-bg);` (`#181b22`)
  - `box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);`
- **Headers**:
  - `min-height: 42px;`
  - `padding: 0.5rem 0.85rem;`
  - `border-bottom: 1px solid var(--border-subtle);`
  - Include an icon + bold title (`0.88rem`, `font-weight: 600`) + metadata badge + action buttons.

---

## 4. Component Design Specifications

### A. Buttons (`Kiro Crew & ShadCN Button Variants`)
All buttons must be compact, neatly padded, and use `border-radius: 6px`:

1. **Primary Action Button** (`.btn-primary` / `.ai-card-btn.is-primary`):
   ```css
   height: 28px;
   padding: 0 0.75rem;
   border-radius: 6px;
   background: #2563eb;
   border: 1px solid rgba(255, 255, 255, 0.15);
   color: #ffffff;
   font-size: 0.78rem;
   font-weight: 500;
   display: inline-flex;
   align-items: center;
   gap: 0.35rem;
   cursor: pointer;
   transition: all 0.15s ease;
   ```
2. **Secondary / Outline Button** (`.btn-secondary`, `.ai-card-btn`, `.swimlane-menu-btn`):
   ```css
   height: 26px; /* or 28px */
   padding: 0 0.55rem;
   border-radius: 6px;
   background: #1a1d25;
   border: 1px solid #27272a;
   color: #e4e4e7;
   font-size: 0.76rem;
   font-weight: 500;
   ```
   - Hover: `background: #262a35; border-color: #3f3f46; color: #ffffff;`
3. **Execute / Run Button** (`.execute-task-btn`):
   ```css
   height: 26px;
   padding: 0 0.65rem;
   background: #00d492;
   border: 1px solid #00d492;
   border-radius: 6px;
   color: #0a0c10;
   font-size: 0.76rem;
   font-weight: 600;
   ```
   - Hover: `background: #34d399; border-color: #34d399; color: #000000;`
4. **Icon-Only Action Button** (`•••` or quick actions):
   ```css
   width: 26px;
   height: 26px;
   border-radius: 6px;
   background: transparent;
   border: 1px solid transparent;
   color: var(--text-muted);
   display: inline-flex;
   align-items: center;
   justify-content: center;
   ```
   - Hover: `background: #262a35; border-color: #27272a; color: #fafafa;`

---

### B. Chips & Status Badges
Chips and badges communicate state without visual clutter:

1. **Pill Status Badge** (`.badge`, `.task-status-pill`):
   - `padding: 0.15rem 0.55rem;`
   - `border-radius: 9999px;`
   - `font-size: 0.72rem;`
   - `font-weight: 500;`
   - **Done / Active**: `background: rgba(0, 212, 146, 0.12); color: #00d492; border: 1px solid rgba(0, 212, 146, 0.25);`
   - **Running**: `background: rgba(6, 182, 212, 0.12); color: #06b6d4; border: 1px solid rgba(6, 182, 212, 0.35);`
   - **Warning / Standby**: `background: rgba(234, 179, 8, 0.12); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.25);`
   - **Danger / Error**: `background: rgba(239, 68, 68, 0.12); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25);`
2. **Code / Tag Chip** (`.tag-chip`):
   - `font-family: var(--font-mono);`
   - `font-size: 0.72rem;`
   - `padding: 0.12rem 0.45rem;`
   - `border-radius: 4px;`
   - `background: rgba(255, 255, 255, 0.05);`
   - `border: 1px solid var(--border-subtle);`

---

### C. Cards & Section Containers
1. **Seamless Card Structure**:
   - `background: var(--card-bg);` (`#181b22`)
   - `border: 1px solid var(--border-subtle);` (`#27272a`)
   - `border-radius: 8px;`
   - `box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);`
   - `overflow: visible;`
2. **Card Active / Selected State**:
   - `border-color: #00d492;`
   - `background: rgba(0, 212, 146, 0.04);`
   - `box-shadow: 0 0 0 1px rgba(0, 212, 146, 0.4), 0 4px 16px rgba(0, 212, 146, 0.08);`
3. **Card Section Headers**:
   - `padding: 0.45rem 0.75rem;`
   - `background: rgba(255, 255, 255, 0.02);`
   - `border-bottom: 1px solid var(--border-subtle);`
   - Flex layout with left title/chevron and right status/actions.

---

### D. Dropdown Menus & Popovers
1. **Menu Container** (`.swimlane-dropdown-menu`, `.custom-dropdown-menu`):
   ```css
   position: absolute;
   top: calc(100% + 4px);
   right: 0;
   background: #181b22;
   border: 1px solid #27272a;
   border-radius: 8px;
   box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6), 0 0 1px rgba(0, 0, 0, 0.4);
   z-index: 1000;
   min-width: 165px;
   padding: 4px;
   display: flex;
   flex-direction: column;
   gap: 2px;
   ```
2. **Menu Items** (`.swimlane-dropdown-item`, `.custom-dropdown-item`):
   ```css
   width: 100%;
   display: flex;
   align-items: center;
   gap: 0.5rem;
   padding: 0.45rem 0.65rem;
   font-size: 0.78rem;
   font-weight: 500;
   color: #e4e4e7;
   background: transparent;
   border: none;
   border-radius: 5px;
   cursor: pointer;
   transition: all 0.12s ease;
   ```
   - Hover: `background: #262a35; color: #ffffff;`
   - Selected / Active: `color: #00d492; background: rgba(0, 212, 146, 0.08);`
   - Danger variant: `color: #ef4444;` -> Hover: `background: rgba(239, 68, 68, 0.12); color: #ffffff;`
3. **Dividers**:
   ```css
   height: 1px;
   background: #27272a;
   margin: 3px 0;
   ```

---

### E. Inputs & Form Controls
```css
height: 32px;
padding: 0 0.65rem;
background: #12141a;
border: 1px solid #27272a;
border-radius: 6px;
color: #fafafa;
font-size: 0.82rem;
outline: none;
transition: border-color 0.15s ease, box-shadow 0.15s ease;
```
- Focus: `border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);`

---

### F. Terminal Palette (`AgentTerminal`)
Matches Kiro Crew's command runner palette:
- Background: `#12141a`
- Foreground: `#e4e4e7`
- Cursor & Green: `#00d492`
- Blue: `#2563eb`
- Cyan: `#06b6d4`
- Selection: `rgba(0, 212, 146, 0.25)`

---

## 5. Implementation Checklist for AI Agents

Whenever creating or modifying any UI element:
- [ ] **Palette Consistency**: Does it use `#12141a` canvas / `#1a1d25` pane / `#181b22` card / `#27272a` hairline border foundation?
- [ ] **Typography**: Are primary UI elements styled with Space Grotesk and code/tags with JetBrains Mono?
- [ ] **Borders**: Are borders subtle (`#27272a`) rather than harsh solid white/light borders?
- [ ] **Button Sizing**: Are buttons compact (`26px` - `28px`), with `border-radius: 6px` and clean icon + text spacing (`0.35rem`)?
- [ ] **Z-Index & Overflow**: Do card containers avoid `overflow: hidden` when holding header dropdowns, and are menus set to `z-index: 1000`?
- [ ] **Hierarchy**: Is text hierarchy clear (bold title -> muted subtext -> colored badge)?
- [ ] **State Feedback**: Are hover, focus-within, and active states smooth (`0.15s ease`) and visibly refined?
