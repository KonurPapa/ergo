import React from 'react';

/**
 * Supported wrapping pairs for markdown and code enclosure.
 */
export const MARKDOWN_WRAPPER_PAIRS: Record<string, [string, string]> = {
  '`': ['`', '`'],
  '*': ['*', '*'],
  '_': ['_', '_'],
  '~': ['~', '~'],
  '"': ['"', '"'],
  "'": ["'", "'"],
  '(': ['(', ')'],
  ')': ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  '<': ['<', '>'],
  '>': ['<', '>'],
  '$': ['$', '$'],
  '=': ['=', '='],
};

/**
 * Intercepts keyboard events on textareas or inputs. When text is selected and a
 * markdown/quote/bracket symbol is pressed, it wraps the selection with the appropriate
 * open/close characters instead of overwriting the selection (matching VS Code / IDE behavior).
 *
 * @param e React KeyboardEvent
 * @param onChange Optional state change handler that receives the new full string value
 * @returns boolean true if event was handled & wrapped, false otherwise
 */
export function handleMarkdownAutoWrap(
  e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  onChange?: (value: string) => void
): boolean {
  // Do not intercept hotkeys with modifiers like Ctrl/Cmd/Alt
  if (e.ctrlKey || e.metaKey || e.altKey) {
    return false;
  }

  const pair = MARKDOWN_WRAPPER_PAIRS[e.key];
  if (!pair) {
    return false;
  }

  const target = e.currentTarget;
  const { selectionStart, selectionEnd, value } = target;

  // Only wrap if there is an active selection (selectionStart !== selectionEnd)
  if (
    selectionStart === null ||
    selectionEnd === null ||
    selectionStart === selectionEnd
  ) {
    return false;
  }

  e.preventDefault();

  const [open, close] = pair;
  const selectedText = value.slice(selectionStart, selectionEnd);
  const wrappedText = `${open}${selectedText}${close}`;
  const start = selectionStart;
  const end = selectionEnd;

  const nextValue = value.slice(0, start) + wrappedText + value.slice(end);

  const newSelectionStart = start + open.length;
  const newSelectionEnd = end + open.length;

  if (onChange) {
    onChange(nextValue);
  } else {
    // For non-controlled inputs, update value and dispatch synthetic input event
    const prototype = target instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(target, nextValue);
    } else {
      target.value = nextValue;
    }

    const event = new Event('input', { bubbles: true });
    target.dispatchEvent(event);
  }

  // Set selection range immediately and in next frame after React re-renders
  target.setSelectionRange(newSelectionStart, newSelectionEnd);
  requestAnimationFrame(() => {
    target.setSelectionRange(newSelectionStart, newSelectionEnd);
  });

  return true;
}
