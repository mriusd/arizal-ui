import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Hover / keyboard-focus tooltip. Bubble portals to `document.body` and uses the top layer so it stays above modal dialogs. */
export function Tooltip({
  content,
  children,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipId = useId();

  const place = useCallback(() => {
    const el = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const bw = bubble?.offsetWidth ?? 0;
    const bh = bubble?.offsetHeight ?? 0;
    let left = r.left;
    let top = r.top - gap - bh;
    left = Math.min(Math.max(8, left), window.innerWidth - Math.max(bw, 40) - 8);
    if (top < 8) top = r.bottom + gap;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const bubble = bubbleRef.current;
    if (bubble && typeof bubble.showPopover === "function") {
      bubble.setAttribute("popover", "manual");
      try {
        if (!bubble.matches(":popover-open")) bubble.showPopover();
      } catch {
        /* unsupported / already open */
      }
    }
    place();
    // Re-measure after popover top-layer promotion.
    requestAnimationFrame(() => place());
    return () => {
      if (bubble && typeof bubble.hidePopover === "function") {
        try {
          if (bubble.matches(":popover-open")) bubble.hidePopover();
        } catch {
          /* ignore */
        }
      }
    };
  }, [open, content, place]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => place();
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, place]);

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  return (
    <span
      className={`ui-tooltip${className ? ` ${className}` : ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hide();
      }}
    >
      <span
        ref={triggerRef}
        className="ui-tooltip-trigger"
        tabIndex={0}
        aria-describedby={open ? tipId : undefined}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <span
            ref={bubbleRef}
            id={tipId}
            role="tooltip"
            className="ui-tooltip-bubble ui-tooltip-bubble-open"
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  );
}
