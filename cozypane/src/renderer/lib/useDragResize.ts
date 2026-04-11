import { useCallback, useEffect, useRef } from 'react';

// Shared drag-to-resize hook. App.tsx previously had three nearly-identical
// `handle*ResizeStart` callbacks (panel width, split ratio, preview width)
// each with its own cleanup ref + `mousemove`/`mouseup` listener wiring +
// unmount cleanup effect. Audit finding L9.
//
// Usage:
//   const startPanelResize = useDragResize({
//     onStart: () => setIsResizing(true),
//     onMove: (e, ctx) => {
//       const delta = ctx.startX - e.clientX;
//       setPanelWidth(Math.max(200, ctx.startWidth + delta));
//     },
//     onEnd: () => setIsResizing(false),
//     getStartValue: () => panelWidthRef.current,
//   });
//
// ...then in JSX:
//   <div className="resize-handle" onMouseDown={startPanelResize} />
//
// Each hook instance owns its own cleanup ref, so multiple resizers on the
// same component don't collide. On unmount any in-flight drag is cleaned up.

export interface DragContext {
  startX: number;
  startY: number;
  startWidth: number;
  containerRect: DOMRect | null;
}

export interface UseDragResizeOptions {
  /** Called when the user presses the mouse button. */
  onStart?: () => void;
  /** Called on every mousemove while dragging. */
  onMove: (e: MouseEvent, ctx: DragContext) => void;
  /** Called when the drag ends (mouseup). */
  onEnd?: () => void;
  /**
   * Read the current "starting value" when the drag begins. Typically a
   * ref.current for a width state. Omit if the move handler doesn't need it.
   */
  getStartValue?: () => number;
  /**
   * Read the container element for drag-bounds calculations (used by the
   * split-ratio handler). Omit if not needed.
   */
  getContainer?: (target: HTMLElement) => HTMLElement | null;
}

export function useDragResize(options: UseDragResizeOptions): (e: React.MouseEvent) => void {
  const { onStart, onMove, onEnd, getStartValue, getContainer } = options;
  const cleanupRef = useRef<(() => void) | null>(null);

  // Stash the latest callbacks in refs so the returned startDrag function
  // can stay stable across renders.
  const onMoveRef = useRef(onMove);
  const onStartRef = useRef(onStart);
  const onEndRef = useRef(onEnd);
  const getStartValueRef = useRef(getStartValue);
  const getContainerRef = useRef(getContainer);
  onMoveRef.current = onMove;
  onStartRef.current = onStart;
  onEndRef.current = onEnd;
  getStartValueRef.current = getStartValue;
  getContainerRef.current = getContainer;

  // Clean up any in-flight drag on unmount so a component that unmounts
  // mid-drag doesn't leave dangling document listeners.
  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    const ctx: DragContext = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: getStartValueRef.current?.() ?? 0,
      containerRect: null,
    };
    const container = getContainerRef.current?.(e.target as HTMLElement);
    ctx.containerRect = container ? container.getBoundingClientRect() : null;

    const moveHandler = (ev: MouseEvent) => onMoveRef.current(ev, ctx);
    const cleanup = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', cleanup);
      cleanupRef.current = null;
      onEndRef.current?.();
    };

    // Abort any previous in-flight drag from this same hook instance.
    cleanupRef.current?.();
    cleanupRef.current = cleanup;
    onStartRef.current?.();
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', cleanup);
  }, []);
}
