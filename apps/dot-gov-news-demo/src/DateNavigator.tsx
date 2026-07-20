import { useEffect, useRef, useState } from "react";

import { displayDate } from "./components";

function offsetDay(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function clamp(value: string, minimum: string, maximum: string): string {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function dayDistance(start: string, end: string): number {
  const startAt = Date.parse(`${start}T12:00:00Z`);
  const endAt = Date.parse(`${end}T12:00:00Z`);
  return Math.max(0, Math.round((endAt - startAt) / 86_400_000));
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
  const dragging = useRef(false);
  const emittedPosition = useRef(clampedPosition);

  useEffect(() => {
    emittedPosition.current = clampedPosition;
    if (!dragging.current) setDragPosition(clampedPosition);
  }, [clampedPosition]);

  function emitDay(value: number): void {
    const day = Math.round(Math.max(0, Math.min(span, value)));
    if (day === emittedPosition.current) return;
    emittedPosition.current = day;
    onChange(offsetDay(minimum, day));
  }

  function moveThumb(value: number): void {
    const next = Math.max(0, Math.min(span, value));
    setDragPosition(next);
    emitDay(next);
  }

  function finishDrag(value: number): void {
    dragging.current = false;
    const snapped = Math.round(Math.max(0, Math.min(span, value)));
    setDragPosition(snapped);
    emitDay(snapped);
  }

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
              onBlur={(event) => finishDrag(Number(event.currentTarget.value))}
              onChange={(event) => moveThumb(Number(event.currentTarget.value))}
              onPointerCancel={(event) =>
                finishDrag(Number(event.currentTarget.value))
              }
              onPointerDown={() => {
                dragging.current = true;
              }}
              onPointerUp={(event) =>
                finishDrag(Number(event.currentTarget.value))
              }
              step="any"
              type="range"
              value={dragPosition}
            />
            <div className="date-ticks" aria-hidden="true">
              <span>{displayDate(minimum)}</span>
              {span > 1 ? <span>{displayDate(midpoint)}</span> : null}
              <span>{displayDate(maximum)}</span>
            </div>
          </div>
          <button
            className="primary-button"
            disabled={asOf >= maximum}
            onClick={() =>
              onChange(clamp(offsetDay(asOf, 1), minimum, maximum))
            }
            type="button"
          >
            Advance date <span aria-hidden="true">→</span>
          </button>
        </div>
      </section>
    </aside>
  );
}
