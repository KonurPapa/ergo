---
name: shadcn-ui-styling
description: >-
  Design system and UI/UX styling guidelines for building and editing modern ShadCN-inspired
  interfaces in the application. Use whenever creating, styling, formatting, or updating UI
  components, cards, buttons, lists, chips, tables, modals, sidebars, tabs, or menus.
---

# ShadCN-Inspired Design System & UI Guidelines

This skill provides the comprehensive styling, layout, and component architecture rules to ensure that every new or modified UI element adheres to a clean, cohesive, and premium **ShadCN-inspired dark aesthetic**.

---

## 1. Core Color Palette & Theme Tokens

Base all UI components on this dark-mode color foundation:

Token Name | Hex / CSS Value | Description / Usage
:--- | :--- | :---
**Canvas / Track Background** | `#191a1c` / `var(--bg-darkest)` | Outermost window background, track areas, gutter spacing.
**Card / Pane Surface** | `#222427` / `var(--bg-pane)` | Elevated surface for panels, vertical columns, cards, and modal bodies.
**Dropdown / Popover Surface** | `#1e2023` / `var(--dropdown-bg)` | Floating dropdowns, context menus, tooltips, popovers (`backdrop-filter: blur(20px)`).
**Subtle Card Surface** | `rgba(255, 255, 255, 0.02)` – `0.035` | Sub-cards, table rows, input backgrounds, and list items.
**Hairline Borders** | `rgba(255, 255, 255, 0.08)` – `0.12` | Clean hairline borders for cards, buttons, separators, and inputs.
**Primary Accent** | `#6366f1` / `#3b82f6` | Primary action buttons, active tab underlines, selected state focus rings.
**Cyan Accent** | `#06b6d4` | Live running states, active agent indicators, unordered tags, terminal accents.
**Emerald Status** | `#10b981` / `#059669` | Success badges, online indicators, run action buttons.
**Amber Status** | `#f59e0b` | Warning states, disabled/standby status, archive action icons.
**Rose Status** | `#f43f5e` / `#ef4444` | Destructive/danger buttons, remove actions, error badges.
**Text Bright** | `#ffffff` | Primary titles, active buttons, headings.
**Text Main** | `rgba(255, 255, 255, 0.82)` | Body text, labels, button text.
**Text Muted** | `rgba(255, 255, 255, 0.45)` – `0.55` | Secondary descriptions, timestamps, count badges, column headers.

---

## 2. Layout & Spacing Architecture

### Panel & Column Layouts
- **Padding & Gaps**: Use consistent `0.55rem` to `0.75rem` outer padding between panes and columns.
- **Card Containers**:
  - `border-radius: 12px;`
  - `border: 1px solid rgba(255, 255, 255, 0.08);`
  - `background: #222427;`
  - `box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);`
- **Headers**:
  - `min-height: 42px;`
  - `padding: 0.5rem 0.85rem;`
  - `border-bottom: 1px solid rgba(255, 255, 255, 0.08);`
  - Include an icon + bold title (`0.88rem`, `font-weight: 600`) + metadata badge + action buttons.

---

## 3. Component Design Specifications

### A. Buttons (`ShadCN Button Variants`)
All buttons must be compact, neatly padded, and use `border-radius: 6px`:

1. **Primary Button** (`.btn-primary` / `.ai-card-btn.is-primary`):
   ```css
   height: 28px;
   padding: 0 0.75rem;
   border-radius: 6px;
   background: var(--accent-primary, #6366f1);
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
2. **Secondary / Outline Button** (`.ai-card-btn`, `.swimlane-menu-btn`):
   ```css
   height: 26px; /* or 28px */
   padding: 0 0.55rem;
   border-radius: 6px;
   background: rgba(255, 255, 255, 0.04);
   border: 1px solid rgba(255, 255, 255, 0.12);
   color: rgba(255, 255, 255, 0.85);
   font-size: 0.76rem;
   font-weight: 500;
   ```
   - Hover: `background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.2); color: #ffffff;`
3. **Success / Run Button** (`.execute-task-btn`):
   ```css
   height: 26px;
   padding: 0 0.65rem;
   background: #059669;
   border: 1px solid rgba(255, 255, 255, 0.15);
   border-radius: 6px;
   color: #ffffff;
   font-size: 0.76rem;
   font-weight: 500;
   ```
4. **Icon-Only Action Button** (`•••` or quick actions):
   ```css
   width: 26px;
   height: 26px;
   border-radius: 6px;
   background: rgba(255, 255, 255, 0.04);
   border: 1px solid rgba(255, 255, 255, 0.1);
   color: var(--text-muted);
   display: inline-flex;
   align-items: center;
   justify-content: center;
   ```

---

### B. Chips & Status Badges
Chips and badges communicate state without visual clutter:

1. **Pill Status Badge** (`.task-status-pill`):
   - `padding: 0.12rem 0.5rem;`
   - `border-radius: 9999px;`
   - `font-size: 0.72rem;`
   - `font-weight: 500;`
   - **Online / Done**: `background: rgba(16, 185, 129, 0.12); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.25);`
   - **Disabled / Standby**: `background: rgba(245, 158, 11, 0.12); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.25);`
   - **Running / Working**: `background: rgba(6, 182, 212, 0.12); color: #06b6d4; border: 1px solid rgba(6, 182, 212, 0.35);`
2. **Code / Tag Chip** (`.tag-chip`):
   - `font-family: var(--font-mono);`
   - `font-size: 0.72rem;`
   - `padding: 0.12rem 0.45rem;`
   - `border-radius: 4px;`
   - `background: rgba(255, 255, 255, 0.05);`
   - `border: 1px solid rgba(255, 255, 255, 0.1);`

---

### C. Cards & Section Containers
1. **Seamless Card Structure**:
   - `background: rgba(255, 255, 255, 0.02);`
   - `border: 1px solid rgba(255, 255, 255, 0.08);`
   - `border-radius: 8px;`
   - `box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);`
   - `overflow: visible;` (ensuring dropdown menus inside headers aren't clipped).
2. **Card Active / Selected State**:
   - `border-color: rgba(139, 92, 246, 0.55);`
   - `background: rgba(139, 92, 246, 0.06);`
   - `box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.25), 0 4px 16px rgba(0, 0, 0, 0.25);`
3. **Card Section Headers**:
   - `padding: 0.45rem 0.75rem;`
   - `background: rgba(255, 255, 255, 0.02);`
   - `border-bottom: 1px solid rgba(255, 255, 255, 0.06);`
   - Flex layout with left title/chevron and right status/actions.

---

### D. Dropdown Menus & Popovers (`ShadCN Dropdowns`)
1. **Menu Container** (`.swimlane-dropdown-menu`, `.card-dropdown-menu`):
   ```css
   position: absolute;
   top: calc(100% + 4px);
   right: 0;
   background: #1e2023;
   backdrop-filter: blur(20px);
   border: 1px solid rgba(255, 255, 255, 0.12);
   border-radius: 8px;
   box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 1px rgba(0, 0, 0, 0.3);
   z-index: 1000;
   min-width: 165px;
   padding: 4px;
   display: flex;
   flex-direction: column;
   gap: 2px;
   animation: dropdownFadeIn 0.15s cubic-bezier(0.16, 1, 0.3, 1);
   ```
2. **Menu Items** (`.swimlane-dropdown-item`):
   ```css
   width: 100%;
   display: flex;
   align-items: center;
   gap: 0.5rem;
   padding: 0.4rem 0.65rem;
   font-size: 0.78rem;
   font-weight: 500;
   color: var(--text-main);
   background: transparent;
   border: none;
   border-radius: 5px;
   cursor: pointer;
   transition: all 0.12s ease;
   ```
   - Hover: `background: rgba(255, 255, 255, 0.08); color: #ffffff;`
   - Danger variant: `color: #f43f5e;` -> Hover: `background: rgba(244, 63, 94, 0.12); color: #ffffff;`
3. **Dividers**:
   ```css
   height: 1px;
   background: rgba(255, 255, 255, 0.08);
   margin: 3px 0;
   ```

---

### E. Inputs & Search Bars
```css
height: 32px;
padding: 0 0.65rem;
background: rgba(255, 255, 255, 0.03);
border: 1px solid rgba(255, 255, 255, 0.1);
border-radius: 6px;
color: #ffffff;
font-size: 0.82rem;
outline: none;
transition: border-color 0.15s ease, box-shadow 0.15s ease;
```
- Focus: `border-color: rgba(99, 102, 241, 0.55); box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);`

---

### F. Lists & Data Rows
- **List Header**: Uppercase, small text (`0.7rem`, `letter-spacing: 0.05em`), muted color (`rgba(255, 255, 255, 0.45)`).
- **Data Rows**: Hairline bottom divider (`border-bottom: 1px solid rgba(255, 255, 255, 0.05)`), subtle padding (`0.55rem 0.75rem`), hover highlight (`background: rgba(255, 255, 255, 0.025)`).

---

## 4. Implementation Checklist for AI Agents

Whenever creating or modifying any UI element:
- [ ] **Palette Consistency**: Does it use the `#191a1c` base track / `#222427` surface / `#1e2023` popover foundation?
- [ ] **Borders**: Are borders subtle (`rgba(255, 255, 255, 0.08)` to `0.12`) rather than harsh solid borders?
- [ ] **Button Sizing**: Are buttons compact (`26px` - `28px`), with `border-radius: 6px` and clean icon + text spacing (`0.35rem`)?
- [ ] **Z-Index & Overflow**: Do card containers avoid `overflow: hidden` when holding header dropdowns, and are menus set to `z-index: 1000`?
- [ ] **Hierarchy**: Is text hierarchy clear (bold title -> muted subtext -> colored badge)?
- [ ] **State Feedback**: Are hover, focus-within, and active states smooth (`0.15s ease`) and visibly refined?
