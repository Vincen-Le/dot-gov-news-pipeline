import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";

import { dotGovApi } from "./api/client";
import { isoDay } from "./domain/as-of";
import { DateNavigator } from "./DateNavigator";
import { NewsMark } from "./NewsMark";
import { RankingPage } from "./RankingPage";
import { StorylinesPage } from "./StorylinesPage";

function clamp(value: string, minimum: string, maximum: string): string {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(value));
}

function storedThemeIsDark(): boolean {
  if (document.documentElement.dataset.theme === "light") return false;
  if (document.documentElement.dataset.theme === "dark") return true;
  try {
    return window.localStorage.getItem("dot-gov-theme") !== "light";
  } catch {
    return true;
  }
}

export function App() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const bootstrap = useQuery({
    queryFn: ({ signal }) => dotGovApi.bootstrap(signal),
    queryKey: ["bootstrap"],
  });
  const bounds = useMemo(() => {
    const items = bootstrap.data?.storylines.items ?? [];
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
  }, [bootstrap.data]);
  const requestedDay = params.get("asOf") ?? "";
  const effectiveDay = isIsoDay(requestedDay)
    ? clamp(requestedDay, bounds.minimum, bounds.maximum)
    : bounds.minimum;
  const [dark, setDark] = useState(storedThemeIsDark);
  const sectionName =
    location.pathname === "/ranking" ? "Ranking" : "Storylines";
  const timelineSearch = `?${new URLSearchParams({ asOf: effectiveDay })}`;

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#000000" : "#f2f0e9");
    try {
      window.localStorage.setItem("dot-gov-theme", dark ? "dark" : "light");
    } catch {
      // Theme persistence is optional in privacy-restricted browsing contexts.
    }
  }, [dark]);

  useEffect(() => {
    if (bootstrap.data === undefined || requestedDay === effectiveDay) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("asOf", effectiveDay);
        return next;
      },
      { replace: true },
    );
  }, [bootstrap.data, effectiveDay, requestedDay, setParams]);

  const setAsOf = (day: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("asOf", day);
        next.delete("page");
        next.delete("storyline");
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <Link
          aria-label="Dot Gov News storylines"
          className="brand"
          to={{ pathname: "/", search: timelineSearch }}
        >
          <NewsMark className="news-mark news-mark--brand" />
          <span>
            Dot Gov News <b>/ {sectionName}</b>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          <NavLink end to={{ pathname: "/", search: timelineSearch }}>
            Storylines
          </NavLink>
          <NavLink to={{ pathname: "/ranking", search: timelineSearch }}>
            Ranking
          </NavLink>
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
      <DateNavigator
        asOf={effectiveDay}
        maximum={bounds.maximum}
        minimum={bounds.minimum}
        onChange={setAsOf}
      />
      <main id="main-content">
        <Routes>
          <Route element={<StorylinesPage asOf={effectiveDay} />} path="/" />
          <Route
            element={<StorylinesPage asOf={effectiveDay} />}
            path="/storylines"
          />
          <Route
            element={<RankingPage asOf={effectiveDay} />}
            path="/ranking"
          />
          <Route element={<StorylinesPage asOf={effectiveDay} />} path="*" />
        </Routes>
      </main>
      <footer className="site-footer">
        <span>Public information connected over time</span>
        <span>Reviewed government source material only</span>
      </footer>
    </div>
  );
}
