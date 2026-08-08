/**
 * Sheet — the overlay layer.
 *
 * Everything that used to grow the page downward (the player card, the career
 * log, the nation/position/league grids, the share menu) now lives in a
 * bottom-anchored panel that slides over the screen instead of lengthening it.
 * The screen behind keeps its place; dismissing returns you exactly where you
 * were. That is the whole point of the layer: on a phone, height is the scarce
 * resource, and a second plane is cheaper than a longer page.
 *
 * The mechanics that separate a real sheet from `position: fixed` on a div:
 * scroll lock that restores position (iOS drops scrollY otherwise), pointer-drag
 * dismissal that reads velocity as well as distance, focus capture and restore,
 * Escape, and a mount-through exit so the panel animates out rather than
 * vanishing. Reduced-motion callers get the same states without the travel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IconX } from "./icons";

/* ── body scroll lock, ref-counted so nested sheets don't fight ── */
let lockCount = 0;
let lockedY = 0;
function lockScroll(): void {
  if (lockCount++ > 0) return;
  lockedY = window.scrollY;
  const s = document.body.style;
  s.position = "fixed"; s.top = `-${lockedY}px`; s.left = "0"; s.right = "0"; s.width = "100%";
}
function unlockScroll(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0) return;
  const s = document.body.style;
  s.position = ""; s.top = ""; s.left = ""; s.right = ""; s.width = "";
  window.scrollTo(0, lockedY);
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Keeps a component mounted through its exit animation. */
function usePresence(open: boolean, ms = 260): boolean {
  const [alive, setAlive] = useState(open);
  useEffect(() => {
    if (open) { setAlive(true); return; }
    const t = window.setTimeout(() => setAlive(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return open || alive;
}

/**
 * Vertical drag that only ever travels downward, reporting a dismissal when the
 * gesture clears either a distance or a flick threshold. Returned handlers go on
 * the grab area; `y` is applied as a live transform by the caller.
 */
function useDragDismiss(onDismiss: () => void, distance = 88) {
  const [y, setY] = useState(0);
  const drag = useRef<{ id: number; y0: number; t0: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Pointer capture on the grab area would swallow the click of any control
    // sitting inside it — which is how the close button ends up doing nothing.
    // A press that starts on a control is that control's, not the drag's.
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, y0: e.clientY, t0: performance.now() };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setY(Math.max(0, e.clientY - d.y0));
  }, []);

  const end = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const dy = Math.max(0, e.clientY - d.y0);
    const v = dy / Math.max(1, performance.now() - d.t0); // px per ms
    setY(0);
    if (dy > distance || (v > 0.5 && dy > 24)) onDismiss();
  }, [onDismiss, distance]);

  return { y, dragging: drag.current !== null, onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };
}

export function Sheet({ open, onClose, title, sub, children, footer, tall = false }: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Reach for the taller detent when the content is a long list worth scrolling. */
  tall?: boolean;
}) {
  const alive = usePresence(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const drag = useDragDismiss(onClose);
  // Travel is driven from inline style rather than a keyframe so a drag can take
  // over the transform mid-flight instead of fighting an animation's fill.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const raf = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    lockScroll();
    const raf = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));

    const onKey = (e: KeyboardEvent) => {
      const el = panelRef.current;
      if (!el) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const f = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (f.length === 0) { e.preventDefault(); return; }
      const first = f[0]!, last = f[f.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      unlockScroll();
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!alive) return null;
  const shown = open && settled;
  return (
    <div className="sheet-layer">
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" style={{ opacity: shown ? 1 : 0 }} />
      <div
        ref={panelRef}
        className={`sheet-panel ${tall ? "sheet-tall" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          transform: drag.y ? `translateY(${drag.y}px)` : shown ? "translateY(0)" : "translateY(101%)",
          transition: drag.y ? "none" : undefined,
        }}
      >
        <div
          className="sheet-head"
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
        >
          <span className="sheet-grab" aria-hidden="true" />
          <div className="sheet-head-text">
            <h2 className="sheet-title">{title}</h2>
            {sub && <p className="sheet-sub">{sub}</p>}
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="关闭">
            <IconX />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
