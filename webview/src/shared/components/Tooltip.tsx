import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  text: string;
  children: ReactNode;
  delay?: number;
  position?: "top" | "bottom";
  onlyWhenTruncated?: boolean;
}

interface TooltipPositionInput {
  trigger: { top: number; bottom: number; left: number; width: number };
  tooltip: { width: number; height: number };
  viewport: { width: number; height: number };
  preferred: "top" | "bottom";
}

export function computeTooltipPosition({
  trigger,
  tooltip,
  viewport,
  preferred,
}: TooltipPositionInput): {
  top: number;
  left: number;
  position: "top" | "bottom";
} {
  const gap = 4;
  const margin = 4;
  const fitsAbove = trigger.top - gap - tooltip.height >= margin;
  const fitsBelow =
    trigger.bottom + gap + tooltip.height <= viewport.height - margin;
  let position = preferred;
  if (preferred === "top" && !fitsAbove && fitsBelow) position = "bottom";
  if (preferred === "bottom" && !fitsBelow && fitsAbove) position = "top";
  if (!fitsAbove && !fitsBelow) {
    const roomAbove = trigger.top - gap - margin;
    const roomBelow = viewport.height - margin - trigger.bottom - gap;
    position = roomAbove >= roomBelow ? "top" : "bottom";
  }

  const halfWidth = tooltip.width / 2;
  const minCenter = margin + halfWidth;
  const maxCenter = viewport.width - margin - halfWidth;
  const desiredCenter = trigger.left + trigger.width / 2;
  const left =
    minCenter > maxCenter
      ? viewport.width / 2
      : Math.min(maxCenter, Math.max(minCenter, desiredCenter));

  const renderedHeight = Math.min(
    tooltip.height,
    Math.max(0, viewport.height - margin * 2),
  );
  const desiredTop =
    position === "top" ? trigger.top - gap : trigger.bottom + gap;
  const top =
    position === "top"
      ? Math.min(
          viewport.height - margin,
          Math.max(margin + renderedHeight, desiredTop),
        )
      : Math.min(
          viewport.height - margin - renderedHeight,
          Math.max(margin, desiredTop),
        );

  return {
    top,
    left,
    position,
  };
}

export function isTooltipContentTruncated(container: HTMLElement): boolean {
  const content = container.firstElementChild as HTMLElement | null;
  if (content && content.scrollWidth > content.clientWidth) return true;
  let candidate: HTMLElement | null = container;
  for (let depth = 0; candidate && depth < 3; depth += 1) {
    if (candidate.scrollWidth > candidate.clientWidth) return true;
    candidate = candidate.parentElement;
  }
  return false;
}

export function Tooltip({
  text,
  children,
  delay = 300,
  position = "top",
  onlyWhenTruncated = false,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [actualPosition, setActualPosition] = useState(position);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const show = useCallback(() => {
    if (onlyWhenTruncated) {
      const container = containerRef.current;
      if (!container || !isTooltipContentTruncated(container)) return;
    }
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [delay, onlyWhenTruncated]);

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
    setCoords(null);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Seed an anchor so the portal can render and be measured.
  useEffect(() => {
    if (!visible || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    setCoords({
      top: position === "top" ? rect.top - 4 : rect.bottom + 4,
      left: rect.left + rect.width / 2,
    });
    setActualPosition(position);
  }, [visible, position]);

  // Measure once and derive the final clamped position from immutable geometry.
  // This avoids the old feedback loop where shifting left could cause the next
  // render to overflow the opposite edge and shift right again.
  useLayoutEffect(() => {
    if (!visible || !coords || !tooltipRef.current) return;
    const trigger = containerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const tooltip = tooltipRef.current.getBoundingClientRect();
    const next = computeTooltipPosition({
      trigger,
      tooltip,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      preferred: position,
    });
    setCoords((previous) =>
      previous &&
      Math.abs(previous.top - next.top) < 0.5 &&
      Math.abs(previous.left - next.left) < 0.5
        ? previous
        : { top: next.top, left: next.left },
    );
    setActualPosition(next.position);
  }, [visible, position, coords]);

  return (
    <div
      ref={containerRef}
      className="tooltip-wrapper"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {visible &&
        coords &&
        createPortal(
          <div
            ref={tooltipRef}
            className="tooltip-popup"
            style={{
              position: "fixed",
              width: "max-content",
              top: coords.top,
              left: coords.left,
              transform:
                actualPosition === "top"
                  ? "translate(-50%, -100%)"
                  : "translateX(-50%)",
              zIndex: 99999,
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </div>
  );
}
