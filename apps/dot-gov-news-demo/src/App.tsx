import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";

import { dotGovApi } from "./api/client";
import { isoDay } from "./domain/as-of";
import { displayDate } from "./components";
import { RankingPage } from "./RankingPage";
import { StorylinesPage } from "./StorylinesPage";

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

function DateSimulator({
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
    <section className="date-simulator" aria-labelledby="date-simulator-label">
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
          onClick={() => onChange(clamp(offsetDay(asOf, 1), minimum, maximum))}
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
  );
}

export function App() {
  const location = useLocation();
  const storylines = useQuery({
    queryFn: ({ signal }) => dotGovApi.storylines(signal),
    queryKey: ["storylines"],
  });
  const bounds = useMemo(() => {
    const items = storylines.data?.items ?? [];
    const starts = items
      .map((item) => isoDay(item.firstEntryAt))
      .filter((day): day is string => day !== null)
      .sort();
    const ends = items
      .map((item) => isoDay(item.newestEntryAt))
      .filter((day): day is string => day !== null)
      .sort();
    const today = new Date().toISOString().slice(0, 10);
    return {
      maximum: ends.at(-1) ?? today,
      minimum: starts[0] ?? today,
    };
  }, [storylines.data]);
  const [asOf, setAsOf] = useState("");
  const [dark, setDark] = useState(() => {
    const stored = window.localStorage.getItem("dot-gov-theme");
    return stored === null ? true : stored === "dark";
  });
  const effectiveDay = asOf === "" ? bounds.maximum : asOf;
  const sectionName =
    location.pathname === "/ranking" ? "Ranking" : "Storylines";

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    window.localStorage.setItem("dot-gov-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    if (asOf !== "")
      setAsOf((day) => clamp(day, bounds.minimum, bounds.maximum));
  }, [asOf, bounds.maximum, bounds.minimum]);

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <Link aria-label="Dot Gov News storylines" className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            Dot Gov News <b>/ {sectionName}</b>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          <NavLink end to="/">
            Storylines
          </NavLink>
          <NavLink to="/ranking">Ranking</NavLink>
        </nav>
        <div className="header-tools">
          <button
            aria-label={`Use ${dark ? "light" : "dark"} theme`}
            className="theme-toggle"
            onClick={() => setDark((value) => !value)}
            type="button"
          >
            {dark ? "○" : "●"}
          </button>
          <span className="environment">Preview edition</span>
        </div>
      </header>
      <main id="main-content">
        <Routes>
          <Route
            element={
              <StorylinesPage
                asOf={effectiveDay}
                dateSimulator={
                  <DateSimulator
                    asOf={effectiveDay}
                    maximum={bounds.maximum}
                    minimum={bounds.minimum}
                    onChange={(day) => setAsOf(day)}
                  />
                }
              />
            }
            path="/"
          />
          <Route
            element={
              <StorylinesPage
                asOf={effectiveDay}
                dateSimulator={
                  <DateSimulator
                    asOf={effectiveDay}
                    maximum={bounds.maximum}
                    minimum={bounds.minimum}
                    onChange={(day) => setAsOf(day)}
                  />
                }
              />
            }
            path="/storylines"
          />
          <Route
            element={<RankingPage asOf={effectiveDay} />}
            path="/ranking"
          />
          <Route
            element={
              <StorylinesPage
                asOf={effectiveDay}
                dateSimulator={
                  <DateSimulator
                    asOf={effectiveDay}
                    maximum={bounds.maximum}
                    minimum={bounds.minimum}
                    onChange={(day) => setAsOf(day)}
                  />
                }
              />
            }
            path="*"
          />
        </Routes>
      </main>
      <footer className="site-footer">
        <span>Public information connected over time</span>
        <span>Reviewed government source material only</span>
      </footer>
    </div>
  );
}
