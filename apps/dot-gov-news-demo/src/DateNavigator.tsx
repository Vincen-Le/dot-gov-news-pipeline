import { type CSSProperties, useEffect, useRef, useState } from "react";

import { displayDate } from "./components";

function offsetDay(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayDistance(start: string, end: string): number {
  const startAt = Date.parse(`${start}T12:00:00Z`);
  const endAt = Date.parse(`${end}T12:00:00Z`);
  return Math.max(0, Math.round((endAt - startAt) / 86_400_000));
}

const ARROW_MOTION_MS = 460;
const SNAP_MOTION_MS = 220;

function magneticProgress(value: number): number {
  const progress = Math.max(0, Math.min(1, value));
  const tension = 8;
  const position = 1 - Math.exp(-tension * progress) * (1 + tension * progress);
  const end = 1 - Math.exp(-tension) * (1 + tension);
  return position / end;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function DateNavigator({
  asOf,
  maximum,
  minimum,
  onChange,
}: {
  asOf: string;
  maximum: string;
  minimum: string;
  onChange: (day: string) => void;
}) {
  const span = dayDistance(minimum, maximum);
  const position = dayDistance(minimum, asOf);
  const clampedPosition = Math.min(position, span);
  const midpoint = offsetDay(minimum, Math.round(span / 2));
  const [dragPosition, setDragPosition] = useState(clampedPosition);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isTicking, setIsTicking] = useState(false);
  const dragging = useRef(false);
  const animating = useRef(false);
  const animationFrame = useRef<number | null>(null);
  const tickFrame = useRef<number | null>(null);
  const tickTimer = useRef<number | null>(null);
  const visualPosition = useRef(clampedPosition);
  const emittedPosition = useRef(clampedPosition);

  useEffect(() => {
    emittedPosition.current = clampedPosition;
    if (!dragging.current && !animating.current) {
      visualPosition.current = clampedPosition;
      setDragPosition(clampedPosition);
    }
  }, [clampedPosition]);

  useEffect(
    () => () => {
      if (animationFrame.current !== null)
        window.cancelAnimationFrame(animationFrame.current);
      if (tickFrame.current !== null)
        window.cancelAnimationFrame(tickFrame.current);
      if (tickTimer.current !== null) window.clearTimeout(tickTimer.current);
    },
    [],
  );

  function updateVisualPosition(value: number): void {
    const next = Math.max(0, Math.min(span, value));
    visualPosition.current = next;
    setDragPosition(next);
  }

  function signalTick(): void {
    const hapticNavigator = navigator as Navigator & {
      vibrate?: (pattern: number | number[]) => boolean;
    };
    hapticNavigator.vibrate?.(7);

    if (tickFrame.current !== null)
      window.cancelAnimationFrame(tickFrame.current);
    if (tickTimer.current !== null) window.clearTimeout(tickTimer.current);
    setIsTicking(false);
    tickFrame.current = window.requestAnimationFrame(() => {
      setIsTicking(true);
      tickTimer.current = window.setTimeout(() => setIsTicking(false), 160);
    });
  }

  function emitDay(value: number, withTick = true): void {
    const day = Math.round(Math.max(0, Math.min(span, value)));
    if (day === emittedPosition.current) return;
    emittedPosition.current = day;
    if (withTick) signalTick();
    onChange(offsetDay(minimum, day));
  }

  function moveThumb(value: number): void {
    const previous = visualPosition.current;
    const next = Math.max(0, Math.min(span, value));
    updateVisualPosition(next);

    const crossedDay =
      next > previous
        ? Math.floor(next + Number.EPSILON)
        : next < previous
          ? Math.ceil(next - Number.EPSILON)
          : emittedPosition.current;
    emitDay(crossedDay);
  }

  function cancelAnimation(): void {
    if (animationFrame.current !== null) {
      window.cancelAnimationFrame(animationFrame.current);
      animationFrame.current = null;
    }
    animating.current = false;
    setIsAnimating(false);
  }

  function animateTo(targetValue: number, duration: number): void {
    cancelAnimation();
    const target = Math.round(Math.max(0, Math.min(span, targetValue)));
    const origin = visualPosition.current;

    if (prefersReducedMotion() || Math.abs(target - origin) < 0.001) {
      updateVisualPosition(target);
      emitDay(target);
      return;
    }

    animating.current = true;
    setIsAnimating(true);
    let startedAt: number | null = null;

    const animate = (now: number) => {
      startedAt ??= now;
      const elapsed = Math.min(1, (now - startedAt) / duration);
      const next = origin + (target - origin) * magneticProgress(elapsed);
      updateVisualPosition(elapsed === 1 ? target : next);

      if (elapsed < 1) {
        animationFrame.current = window.requestAnimationFrame(animate);
        return;
      }

      animationFrame.current = null;
      animating.current = false;
      setIsAnimating(false);
      emitDay(target);
    };

    animationFrame.current = window.requestAnimationFrame(animate);
  }

  function finishDrag(value: number): void {
    if (animating.current) return;
    dragging.current = false;
    const snapped = Math.round(Math.max(0, Math.min(span, value)));
    animateTo(snapped, SNAP_MOTION_MS);
  }

  function stepDate(direction: -1 | 1): void {
    const target = Math.max(
      0,
      Math.min(span, emittedPosition.current + direction),
    );
    if (target === emittedPosition.current) return;
    animateTo(target, ARROW_MOTION_MS);
  }

  const progress = span === 0 ? 0 : (dragPosition / span) * 100;
  const rangeStyle = {
    "--date-progress": `${progress}%`,
  } as CSSProperties;

  return (
    <aside className="date-navigation" aria-label="Timeline navigation">
      <section
        className="date-simulator"
        aria-labelledby="date-simulator-label"
      >
        <header>
          <span className="micro-label" id="date-simulator-label">
            Simulated publication date
          </span>
          <time className="as-of-value" dateTime={asOf}>
            {displayDate(asOf)}
          </time>
        </header>
        <div className="date-control-row">
          <div className="date-track">
            <input
              aria-label="Simulated publication date"
              aria-valuetext={displayDate(
                offsetDay(minimum, Math.round(dragPosition)),
              )}
              max={span}
              min="0"
              className={`date-range${isTicking ? " is-ticking" : ""}`}
              onBlur={(event) => finishDrag(Number(event.currentTarget.value))}
              onChange={(event) => moveThumb(Number(event.currentTarget.value))}
              onKeyDown={(event) => {
                if (
                  [
                    "ArrowDown",
                    "ArrowLeft",
                    "ArrowRight",
                    "ArrowUp",
                    "End",
                    "Home",
                    "PageDown",
                    "PageUp",
                  ].includes(event.key)
                )
                  dragging.current = true;
              }}
              onKeyUp={(event) => finishDrag(Number(event.currentTarget.value))}
              onPointerCancel={(event) =>
                finishDrag(Number(event.currentTarget.value))
              }
              onPointerDown={() => {
                cancelAnimation();
                dragging.current = true;
              }}
              onPointerUp={(event) =>
                finishDrag(Number(event.currentTarget.value))
              }
              step="any"
              style={rangeStyle}
              type="range"
              value={dragPosition}
            />
            <div className="date-ticks" aria-hidden="true">
              <span>{displayDate(minimum)}</span>
              {span > 1 ? <span>{displayDate(midpoint)}</span> : null}
              <span>{displayDate(maximum)}</span>
            </div>
          </div>
          <div
            aria-label="Step through publication dates"
            className="date-stepper"
            role="group"
          >
            <button
              aria-label="Previous date"
              className="date-arrow"
              disabled={isAnimating || asOf <= minimum}
              onClick={() => stepDate(-1)}
              title="Previous date"
              type="button"
            >
              <span aria-hidden="true">←</span>
            </button>
            <button
              aria-label="Next date"
              className="date-arrow"
              disabled={isAnimating || asOf >= maximum}
              onClick={() => stepDate(1)}
              title="Next date"
              type="button"
            >
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </section>
    </aside>
  );
}
