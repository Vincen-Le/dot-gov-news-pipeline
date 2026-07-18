import { useCallback, useEffect, useRef, useState } from "react";

export type LiveState =
  "idle" | "connecting" | "live" | "reconnecting" | "stopped" | "stale";

export interface LiveActivity {
  receivedAt: string;
  value: unknown;
}

export function useLiveActivity(
  limit = 50,
  paused = false,
): {
  activities: LiveActivity[];
  flush: () => void;
  pendingCount: number;
  state: LiveState;
} {
  const [activities, setActivities] = useState<LiveActivity[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [state, setState] = useState<LiveState>("idle");
  const pausedRef = useRef(paused);
  const pendingRef = useRef<LiveActivity[]>([]);
  pausedRef.current = paused;

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = [];
    setPendingCount(0);
    if (pending.length > 0) {
      setActivities((current) => [...pending, ...current].slice(0, limit));
    }
  }, [limit]);

  useEffect(() => {
    const source = new EventSource("/api/live");
    const onState = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { state?: LiveState };
        setState(payload.state ?? "reconnecting");
      } catch {
        setState("reconnecting");
      }
    };
    const onActivity = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as LiveActivity;
        if (pausedRef.current) {
          pendingRef.current = [payload, ...pendingRef.current].slice(0, limit);
          setPendingCount(pendingRef.current.length);
        } else {
          setActivities((current) => [payload, ...current].slice(0, limit));
        }
      } catch {
        setState("reconnecting");
      }
    };
    source.addEventListener("state", onState);
    source.addEventListener("activity", onActivity);
    source.onerror = () => setState("reconnecting");
    return () => source.close();
  }, [limit]);

  useEffect(() => {
    if (activities[0] === undefined) return;
    const delay = Math.max(
      1_000,
      30_000 - (Date.now() - Date.parse(activities[0].receivedAt)),
    );
    const timer = window.setTimeout(() => {
      setState((current) => (current === "live" ? "stale" : current));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activities]);

  return { activities, flush, pendingCount, state };
}
