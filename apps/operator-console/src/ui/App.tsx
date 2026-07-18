import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";

import { operatorRecipes } from "../recipes";
import { CapabilityPage } from "./pages/CapabilityPage";
import { EventsPage } from "./pages/EventsPage";
import { InventoryPage } from "./pages/InventoryPage";
import { OverviewPage } from "./pages/OverviewPage";
import { StorylineDetailPage } from "./pages/StorylineDetailPage";
import { StorylinesPage } from "./pages/StorylinesPage";
import { SystemPage } from "./pages/SystemPage";

const navigation = [
  ["/", "Overview"],
  ["/inventory", "Inventory"],
  ["/discovery", "Discovery"],
  ["/feeds", "Feeds"],
  ["/storylines", "Storylines"],
  ["/events", "Events"],
  ["/system", "System"],
] as const;

function CommandPalette({ close }: { close: () => void }) {
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const recipes = useMemo(() => {
    const normalized = query.toLowerCase();
    return operatorRecipes.filter((recipe) =>
      `${recipe.title} ${recipe.description} ${recipe.cli}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [query]);

  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  return (
    <dialog
      aria-label="Operator commands"
      className="palette-backdrop"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      ref={dialog}
    >
      <div
        className="command-palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label htmlFor="command-search">
          Search commands, hostnames, and views
        </label>
        <input
          autoFocus
          id="command-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try “deep health”"
          value={query}
        />
        <ul>
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              <button
                onClick={() => {
                  navigate(recipe.view);
                  close();
                }}
                type="button"
              >
                <span>
                  <strong>{recipe.title}</strong>
                  <small>{recipe.description}</small>
                </span>
                <code>{recipe.cli}</code>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
}

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [light, setLight] = useState(
    () => localStorage.getItem("ops-theme") === "light",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = light ? "light" : "dark";
    localStorage.setItem("ops-theme", light ? "light" : "dark");
  }, [light]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" to="/">
          <span aria-hidden="true" className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>
            Dot Gov News <b>/ Operations</b>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          {navigation.map(([path, label]) => (
            <NavLink
              className={({ isActive }) => (isActive ? "active" : undefined)}
              end={path === "/"}
              key={path}
              to={path}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="header-actions">
          <button
            className="command-trigger"
            onClick={() => setPaletteOpen(true)}
            type="button"
          >
            Search <kbd>⌘K</kbd>
          </button>
          <button
            aria-label={`Use ${light ? "dark" : "light"} theme`}
            className="theme-button"
            onClick={() => setLight((current) => !current)}
            type="button"
          >
            {light ? "●" : "○"}
          </button>
          <span className="environment">Local observer</span>
        </div>
      </header>
      <main id="main-content">
        <Routes>
          <Route element={<OverviewPage />} path="/" />
          <Route element={<InventoryPage />} path="/inventory" />
          <Route
            element={
              <CapabilityPage capability="discovery" title="Discovery" />
            }
            path="/discovery"
          />
          <Route
            element={<CapabilityPage capability="feeds" title="Feeds" />}
            path="/feeds"
          />
          <Route element={<StorylinesPage />} path="/storylines" />
          <Route element={<StorylineDetailPage />} path="/storylines/:id" />
          <Route element={<EventsPage />} path="/events" />
          <Route element={<SystemPage />} path="/system" />
          <Route element={<OverviewPage />} path="*" />
        </Routes>
      </main>
      <footer>
        <span>Private local observer</span>
        <span>Supabase is authoritative · live logs are sampled</span>
      </footer>
      {paletteOpen ? (
        <CommandPalette close={() => setPaletteOpen(false)} />
      ) : null}
    </div>
  );
}
