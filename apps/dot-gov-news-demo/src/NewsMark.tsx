import "./NewsMark.css";

export function NewsMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      viewBox="0 0 24 18"
    >
      <rect
        fill="none"
        height="16"
        stroke="currentColor"
        strokeWidth="2"
        width="22"
        x="1"
        y="1"
      />
      <path
        d="M5 5h14M5 8h10M5 11h14M5 14h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
