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
  const midpoint = offsetDay(minimum, Math.round(span / 2));

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
          <input
            aria-label="Simulated publication date"
            max={span}
            min="0"
            onChange={(event) =>
              onChange(offsetDay(minimum, Number(event.target.value)))
            }
            step="1"
            type="range"
            value={Math.min(position, span)}
          />
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
        <div className="date-ticks" aria-hidden="true">
          <span>{displayDate(minimum)}</span>
          {span > 1 ? <span>{displayDate(midpoint)}</span> : null}
          <span>{displayDate(maximum)}</span>
        </div>
      </section>
    </aside>
  );
}
