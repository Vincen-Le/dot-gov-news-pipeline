import type {
  ComponentHealth,
  OperatorCapabilityState,
  QueueMetric,
} from "@dot-gov-news/contracts";
import type { ReactNode } from "react";

export function SectionHeading({
  index,
  title,
  aside,
}: {
  aside?: ReactNode;
  index: string;
  title: string;
}) {
  return (
    <header className="section-heading">
      <div>
        <span className="section-index">{index}</span>
        <h2>{title}</h2>
      </div>
      {aside}
    </header>
  );
}

export function StatusMark({
  label,
  status,
}: {
  label: string;
  status: "healthy" | "attention" | "failed" | "live" | "muted";
}) {
  return (
    <span className={`status-mark status-${status}`}>
      <span aria-hidden="true" className="status-dot" />
      {label}
    </span>
  );
}

export function LoadingState({
  label = "Loading current state",
}: {
  label?: string;
}) {
  return (
    <div aria-live="polite" className="state-block">
      <span className="loading-line" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="state-block state-error" role="alert">
      <strong>Unable to read this source.</strong>
      <span>
        {error instanceof Error ? error.message : "Unknown read failure"}
      </span>
    </div>
  );
}

export function NotEnabled({
  capability,
  title,
}: {
  capability: OperatorCapabilityState | undefined;
  title: string;
}) {
  return (
    <div className="not-enabled">
      <span className="eyebrow">Not enabled</span>
      <h2>{title}</h2>
      <p>
        {capability?.reason ??
          "This stage does not have a durable implementation yet. It is intentionally not shown as zero."}
      </p>
    </div>
  );
}

export function QueueTable({ queues }: { queues: QueueMetric[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Queue</th>
            <th>Backlog</th>
            <th>Bytes</th>
            <th>Oldest</th>
            <th>Observed</th>
          </tr>
        </thead>
        <tbody>
          {queues.map((queue) => (
            <tr key={queue.name}>
              <th scope="row">{queue.name}</th>
              <td className="numeric">
                {queue.backlogCount === null
                  ? "Unavailable"
                  : `~${queue.backlogCount}`}
              </td>
              <td className="numeric">
                {queue.backlogBytes === null ? "—" : `~${queue.backlogBytes}`}
              </td>
              <td>
                {queue.oldestMessageAt === null ? (
                  "—"
                ) : (
                  <time
                    dateTime={queue.oldestMessageAt}
                    title={new Date(queue.oldestMessageAt).toLocaleString()}
                  >
                    {relativeTime(queue.oldestMessageAt)}
                  </time>
                )}
              </td>
              <td>
                <time
                  dateTime={queue.observedAt}
                  title={new Date(queue.observedAt).toLocaleString()}
                >
                  {relativeTime(queue.observedAt)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ComponentList({
  components,
}: {
  components: ComponentHealth[];
}) {
  return (
    <ul className="component-list">
      {components.map((component) => (
        <li key={component.name}>
          <StatusMark
            label={component.status.replace("_", " ")}
            status={
              component.status === "healthy"
                ? "healthy"
                : component.status === "failed"
                  ? "failed"
                  : "attention"
            }
          />
          <strong>{component.name.replaceAll("_", " ")}</strong>
          <span>
            {component.latencyMs === null ? "—" : `${component.latencyMs} ms`}
            {component.message === null ? null : ` · ${component.message}`}
            {` · ${relativeTime(component.checkedAt)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function relativeTime(timestamp: string): string {
  const seconds = Math.round((Date.now() - Date.parse(timestamp)) / 1000);
  if (Math.abs(seconds) < 60) return `${Math.max(0, seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${Math.max(0, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return `${Math.max(0, hours)}h ago`;
  return new Date(timestamp).toLocaleString();
}

export function CopyCommand({ command }: { command: string }) {
  return (
    <button
      className="text-button"
      onClick={() => void navigator.clipboard.writeText(command)}
      type="button"
    >
      Copy CLI query
    </button>
  );
}
