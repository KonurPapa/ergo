import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';

export interface ResizableTerminalContainerProps {
  /** Default height in pixels (default: 480) */
  defaultHeight?: number;
  /** Minimum height in pixels (default: 220) */
  minHeight?: number;
  /** Maximum height in pixels (default: 950) */
  maxHeight?: number;
  /** Target height when maximized (default: 760 or window-derived) */
  maximizedHeight?: number;
  /** LocalStorage key for persisting height preference */
  storageKey?: string;
  /** Custom content for the topbar left area (e.g. cmd, cwd, title) */
  headerLeft?: React.ReactNode;
  /** Custom buttons/controls for the topbar right area */
  headerRight?: React.ReactNode;
  /** Terminal child component (e.g. <AgentTerminal />) */
  children: React.ReactNode;
  /** Custom wrapper className */
  className?: string;
  /** Custom wrapper style */
  style?: React.CSSProperties;
  /** Whether to show the topbar (default: true) */
  showHeader?: boolean;
  /** Whether to allow maximizing the terminal (default: true) */
  allowMaximize?: boolean;
  /** Optional callback fired when height changes */
  onHeightChange?: (height: number) => void;
}

export const ResizableTerminalContainer: React.FC<ResizableTerminalContainerProps> = ({
  defaultHeight = 480,
  minHeight = 220,
  maxHeight = 950,
  maximizedHeight,
  storageKey,
  headerLeft,
  headerRight,
  children,
  className = '',
  style = {},
  showHeader = true,
  allowMaximize = true,
  onHeightChange,
}) => {
  // Read saved height from localStorage or fall back to defaultHeight
  const [height, setHeight] = useState<number>(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed = parseInt(saved, 10);
          if (!isNaN(parsed) && parsed >= minHeight && parsed <= maxHeight) {
            return parsed;
          }
        }
      } catch {}
    }
    return defaultHeight;
  });

  const [isDragging, setIsDragging] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isHandleHovered, setIsHandleHovered] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const startHeightRef = useRef(0);
  const heightRef = useRef(height);
  const prevHeightRef = useRef(height);
  const animFrameRef = useRef<number | null>(null);

  // Keep heightRef in sync
  useEffect(() => {
    heightRef.current = height;
    onHeightChange?.(height);
  }, [height, onHeightChange]);

  // Handle Dragging
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartYRef.current = e.clientY;
    startHeightRef.current = heightRef.current;
    setIsDragging(true);

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;

      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }

      animFrameRef.current = requestAnimationFrame(() => {
        const delta = e.clientY - dragStartYRef.current;
        const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeightRef.current + delta));
        heightRef.current = newHeight;
        setHeight(newHeight);
        setIsMaximized(false);
      });
    };

    const onMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);

      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }

      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Persist finalized height
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, String(heightRef.current));
        } catch {}
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [minHeight, maxHeight, storageKey]);

  // Double click reset to default height
  const handleResetToDefault = useCallback(() => {
    setHeight(defaultHeight);
    heightRef.current = defaultHeight;
    setIsMaximized(false);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, String(defaultHeight));
      } catch {}
    }
  }, [defaultHeight, storageKey]);

  // Toggle maximize
  const handleToggleMaximize = useCallback(() => {
    if (isMaximized) {
      // Restore previous size
      const targetHeight = Math.max(minHeight, Math.min(maxHeight, prevHeightRef.current || defaultHeight));
      setHeight(targetHeight);
      heightRef.current = targetHeight;
      setIsMaximized(false);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, String(targetHeight));
        } catch {}
      }
    } else {
      // Maximize
      prevHeightRef.current = heightRef.current;
      const calcMax = maximizedHeight || Math.min(Math.max(600, window.innerHeight - 200), maxHeight);
      setHeight(calcMax);
      heightRef.current = calcMax;
      setIsMaximized(true);
    }
  }, [isMaximized, defaultHeight, minHeight, maxHeight, maximizedHeight, storageKey]);

  return (
    <div
      ref={containerRef}
      className={`resizable-terminal-container ${className}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        position: 'relative',
        ...style,
      }}
    >
      {/* ── Top Bar ────────────────────────────────────────────── */}
      {showHeader && (
        <div className="resizable-terminal-topbar">
          <div className="resizable-terminal-topbar-left">
            {headerLeft}
          </div>

          <div className="resizable-terminal-topbar-right">
            {headerRight}

            {/* Height Indicator Badge on Hover/Drag */}
            <span
              className={`resizable-terminal-height-tag ${isHandleHovered || isDragging ? 'is-visible' : ''}`}
              title="Current terminal height. Drag bottom handle to resize, double-click to reset."
            >
              {Math.round(height)}px
            </span>

            {/* Reset Size Button */}
            {height !== defaultHeight && (
              <button
                type="button"
                className="terminal-ctrl-btn"
                onClick={handleResetToDefault}
                title={`Reset to default height (${defaultHeight}px)`}
              >
                <RotateCcw size={11} />
                <span>Reset</span>
              </button>
            )}

            {/* Maximize / Restore Toggle */}
            {allowMaximize && (
              <button
                type="button"
                className={`terminal-ctrl-btn ${isMaximized ? 'is-active' : ''}`}
                onClick={handleToggleMaximize}
                title={isMaximized ? 'Restore previous terminal size' : 'Expand terminal to maximized view'}
              >
                {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                <span>{isMaximized ? 'Restore' : 'Expand'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Terminal Body ──────────────────────────────────────── */}
      <div
        className="resizable-terminal-body"
        style={{
          height: `${height}px`,
          position: 'relative',
          overflow: 'hidden',
          width: '100%',
        }}
      >
        {children}

        {/* Drag Interaction Overlay: prevents mouse event capture by xterm canvas/DOM */}
        {isDragging && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 100,
              cursor: 'ns-resize',
              background: 'transparent',
            }}
          />
        )}
      </div>

      {/* ── Bottom Resize Drag Handle ──────────────────────────── */}
      <div
        className={`terminal-resize-handle ${isDragging ? 'is-dragging' : ''}`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleResetToDefault}
        onMouseEnter={() => setIsHandleHovered(true)}
        onMouseLeave={() => setIsHandleHovered(false)}
        title={`Drag to resize terminal (${Math.round(height)}px) • Double-click to reset to ${defaultHeight}px`}
      >
        <div className="terminal-resize-grip" />
        <span className="terminal-resize-handle-tip">
          {Math.round(height)}px
        </span>
      </div>
    </div>
  );
};
