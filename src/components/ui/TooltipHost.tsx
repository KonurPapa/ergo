import { useEffect } from 'react';

/**
 * One tooltip for the whole app, in place of the browser's native `title` tooltip.
 *
 * Mounted once. It listens at the document level, so it covers everything with a `title` attribute: React buttons,
 * badges, and the raw-DOM gutter icons inside the TipTap editor alike. While an element is hovered (or keyboard
 * focused) its `title` is parked in `data-tooltip` so the native tooltip never shows, and put back when the pointer
 * leaves, so the DOM stays as the code that owns it left it. A `title` set while the element is hovered is picked up.
 *
 * Accessibility: an element whose only accessible name was its `title` gets that as `aria-label` (and keeps it); an
 * element with visible text gets it as `aria-description`. A tooltip whose text just repeats the element's visible
 * text is skipped (e.g. a button label shown in full), so labels that collapse to icons get a tooltip only when
 * collapsed.
 */

const SHOW_DELAY_MS = 450;
/** After a tooltip hides, the next one shows at once for this long (moving along a toolbar). */
const WARM_MS = 400;
const GAP = 6;
const MARGIN = 8;

const ARIA_MARK = 'data-eg-tip-aria';

function normalize(s: string | null | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function visibleText(el: Element): string {
  return el instanceof HTMLElement ? normalize(el.innerText) : normalize(el.textContent);
}

/** The tooltip would only repeat what the element already shows (a button label shown in full). */
function repeatsVisibleText(el: Element, text: string): boolean {
  const t = normalize(text);
  return t.length > 0 && visibleText(el).includes(t);
}

/** Give the element an accessible name/description from its title, without overriding one the code set. */
function syncAria(el: Element, text: string) {
  const mark = el.getAttribute(ARIA_MARK);
  if (mark === 'label') {
    el.setAttribute('aria-label', text);
    return;
  }
  if (mark === 'description') {
    el.setAttribute('aria-description', text);
    return;
  }
  if (el.hasAttribute('aria-labelledby')) return;
  const label = el.getAttribute('aria-label');
  if (label == null && !normalize(el.textContent)) {
    el.setAttribute('aria-label', text);
    el.setAttribute(ARIA_MARK, 'label');
  } else if (
    normalize(label) !== normalize(text) &&
    normalize(el.textContent) !== normalize(text) &&
    !el.hasAttribute('aria-description') &&
    !el.hasAttribute('aria-describedby')
  ) {
    el.setAttribute('aria-description', text);
    el.setAttribute(ARIA_MARK, 'description');
  }
}

export function TooltipHost() {
  useEffect(() => {
    const tip = document.createElement('div');
    tip.className = 'eg-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.id = 'eg-tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);

    /** The element whose title is parked (hovered or focused). */
    let current: Element | null = null;
    /** How it became current: a pointer can't steal a keyboard-focused tooltip's element and vice versa. */
    let source: 'pointer' | 'focus' = 'pointer';
    let text = '';
    let showTimer: number | undefined;
    let hiddenAt = -Infinity;
    let visible = false;
    /** Pressed: no tooltip on this element again until the pointer leaves it. */
    let suppressed: Element | null = null;
    const observer = new MutationObserver(() => {
      if (current && current.hasAttribute('title')) park(current);
    });

    const hide = () => {
      window.clearTimeout(showTimer);
      showTimer = undefined;
      if (visible) hiddenAt = performance.now();
      visible = false;
      tip.hidden = true;
      tip.classList.remove('is-shown');
    };

    const position = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      tip.style.left = '0px';
      tip.style.top = '0px';
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let top = r.top - GAP - th;
      let side: 'top' | 'bottom' = 'top';
      if (top < MARGIN) {
        top = r.bottom + GAP;
        side = 'bottom';
        if (top + th > vh - MARGIN) top = Math.max(MARGIN, vh - MARGIN - th);
      }
      const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - tw / 2), Math.max(MARGIN, vw - MARGIN - tw));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
      tip.dataset.side = side;
      return true;
    };

    const show = () => {
      showTimer = undefined;
      if (!current || !current.isConnected || !text) return;
      if (repeatsVisibleText(current, text)) return;
      tip.textContent = text;
      tip.hidden = false;
      if (!position(current)) {
        tip.hidden = true;
        return;
      }
      visible = true;
      // Next frame, so the fade-in runs from the hidden state.
      requestAnimationFrame(() => {
        if (visible) tip.classList.add('is-shown');
      });
    };

    const schedule = () => {
      window.clearTimeout(showTimer);
      const warm = visible || performance.now() - hiddenAt < WARM_MS;
      if (warm) show();
      else showTimer = window.setTimeout(show, SHOW_DELAY_MS);
    };

    /** Move the element's title into data-tooltip (the native tooltip needs `title` to be there). */
    function park(el: Element) {
      const t = el.getAttribute('title');
      if (t == null) return;
      el.removeAttribute('title');
      el.setAttribute('data-tooltip', t);
      text = t;
      if (t.trim()) syncAria(el, t);
      if (visible && el === current) {
        if (!text.trim() || repeatsVisibleText(el, text)) hide();
        else {
          tip.textContent = text;
          position(el);
        }
      }
    }

    /** Put the parked title back, unless the owning code has set a new one meanwhile. */
    const restore = (el: Element) => {
      const parked = el.getAttribute('data-tooltip');
      el.removeAttribute('data-tooltip');
      if (parked != null && !el.hasAttribute('title')) el.setAttribute('title', parked);
    };

    const activate = (el: Element, how: 'pointer' | 'focus') => {
      if (current && current !== el) deactivate();
      const switching = current !== el;
      current = el;
      source = how;
      park(el);
      if (switching) {
        observer.disconnect();
        observer.observe(el, { attributes: true, attributeFilter: ['title'] });
      }
      if (!text.trim() || suppressed === el) return;
      if (switching || !visible) schedule();
    };

    function deactivate() {
      observer.disconnect();
      if (current) restore(current);
      current = null;
      text = '';
      hide();
    }

    const titled = (target: EventTarget | null): Element | null => {
      if (!(target instanceof Element)) return null;
      return target.closest('[title]');
    };

    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const target = e.target as Node | null;
      const cand = titled(e.target);
      const inCurrent = Boolean(current && target && current.contains(target));
      if (suppressed && !(target && suppressed.contains(target))) suppressed = null;
      if (cand && (!inCurrent || (current && current.contains(cand)))) activate(cand, 'pointer');
      else if (!cand && !inCurrent && current) deactivate();
    };

    const onPointerOut = (e: PointerEvent) => {
      // Left the window.
      if (!e.relatedTarget && source === 'pointer' && current) {
        suppressed = null;
        deactivate();
      }
    };

    const onPointerDown = () => {
      if (current) suppressed = current;
      hide();
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = titled(e.target);
      if (!el || !(e.target instanceof Element)) return;
      let keyboard = false;
      try {
        keyboard = e.target.matches(':focus-visible');
      } catch {
        keyboard = false;
      }
      if (!keyboard) {
        // Still give it an accessible name from its title (parking the title would hide it from screen readers).
        const t = el.getAttribute('title');
        if (t && t.trim()) syncAria(el, t);
        return;
      }
      activate(el, 'focus');
    };

    const onFocusOut = () => {
      if (source === 'focus' && current) deactivate();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && visible) {
        if (current) suppressed = current;
        hide();
      }
    };

    const onScroll = () => {
      if (visible || showTimer) hide();
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('wheel', onScroll, { capture: true, passive: true });
    window.addEventListener('blur', deactivate);

    return () => {
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('blur', deactivate);
      deactivate();
      tip.remove();
    };
  }, []);

  return null;
}
