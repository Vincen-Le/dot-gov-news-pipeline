import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

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

const ARROW_MOTION_MS = 360;
const SNAP_MOTION_MS = 220;
const CAROUSEL_BUFFER_DAYS = 8;

const carouselWeekday = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
});

const carouselMonthDay = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function dateAtNoon(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

function magneticProgress(value: number): number {
  const progress = Math.max(0, Math.min(1, value));
  const tension = 8;
  const position = 1 - Math.exp(-tension * progress) * (1 + tension * progress);
  const end = 1 - Math.exp(-tension) * (1 + tension);
  return position / end;
}

function smoothProgress(value: number): number {
  const progress = Math.max(0, Math.min(1, value));
  return progress * progress * (3 - 2 * progress);
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
  const [dragPosition, setDragPosition] = useState(clampedPosition);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isTicking, setIsTicking] = useState(false);
  const animating = useRef(false);
  const animationFrame = useRef<number | null>(null);
  const tickFrame = useRef<number | null>(null);
  const tickTimer = useRef<number | null>(null);
  const visualPosition = useRef(clampedPosition);
  const emittedPosition = useRef(clampedPosition);

  useEffect(() => {
    emittedPosition.current = clampedPosition;
    if (!animating.current) {
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

  function cancelAnimation(): void {
    if (animationFrame.current !== null) {
      window.cancelAnimationFrame(animationFrame.current);
      animationFrame.current = null;
    }
    animating.current = false;
    setIsAnimating(false);
  }

  function animateTo(
    targetValue: number,
    duration: number,
    progress: (value: number) => number = magneticProgress,
    emitImmediately = false,
  ): void {
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
    if (emitImmediately) emitDay(target);
    let startedAt: number | null = null;

    const animate = (now: number) => {
      startedAt ??= now;
      const elapsed = Math.min(1, (now - startedAt) / duration);
      const next = origin + (target - origin) * progress(elapsed);
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

  function stepDate(direction: -1 | 1): void {
    const target = Math.max(
      0,
      Math.min(span, emittedPosition.current + direction),
    );
    if (target === emittedPosition.current) return;
    animateTo(target, ARROW_MOTION_MS, smoothProgress, true);
  }

  function selectDate(target: number): void {
    if (target === emittedPosition.current) return;
    animateTo(target, SNAP_MOTION_MS, magneticProgress, true);
  }

  function handleCarouselKey(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      stepDate(-1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      stepDate(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectDate(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectDate(span);
    }
  }

  const centerPosition = Math.round(dragPosition);
  const firstVisible = Math.max(0, centerPosition - CAROUSEL_BUFFER_DAYS);
  const lastVisible = Math.min(span, centerPosition + CAROUSEL_BUFFER_DAYS);
  const visibleDates = Array.from(
    { length: lastVisible - firstVisible + 1 },
    (_, index) => firstVisible + index,
  );

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
          <div
            aria-label="Choose simulated publication date"
            aria-roledescription="carousel"
            className={`date-carousel${isAnimating ? " is-animating" : ""}`}
            onKeyDown={handleCarouselKey}
            role="group"
          >
            <div className="date-carousel-window">
              {visibleDates.map((dayIndex) => {
                const day = offsetDay(minimum, dayIndex);
                const date = dateAtNoon(day);
                const selected = dayIndex === emittedPosition.current;
                const itemStyle = {
                  "--date-offset": `${(dayIndex - dragPosition) * 112}px`,
                } as CSSProperties;

                return (
                  <button
                    aria-label={displayDate(day)}
                    aria-pressed={selected}
                    className={`date-carousel-item${selected ? " is-selected" : ""}${selected && isTicking ? " is-ticking" : ""}`}
                    key={day}
                    onClick={() => selectDate(dayIndex)}
                    style={itemStyle}
                    tabIndex={selected ? 0 : -1}
                    type="button"
                  >
                    <span className="date-carousel-weekday">
                      {carouselWeekday.format(date)}
                    </span>
                    <time dateTime={day}>{carouselMonthDay.format(date)}</time>
                  </button>
                );
              })}
            </div>
            <p aria-live="polite" className="sr-only">
              {displayDate(offsetDay(minimum, emittedPosition.current))}
            </p>
          </div>
          <div
            aria-label="Step through publication dates"
            className="date-stepper"
            role="group"
          >
            <button
              aria-label="Previous date"
              className="date-arrow"
              disabled={asOf <= minimum}
              onClick={() => stepDate(-1)}
              title="Previous date"
              type="button"
            >
              <span aria-hidden="true">←</span>
            </button>
            <button
              aria-label="Next date"
              className="date-arrow"
              disabled={asOf >= maximum}
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
