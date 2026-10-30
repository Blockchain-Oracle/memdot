import { cn } from "../lib/utils";

/**
 * The MemDot mark: three memory bars, each shorter than the last, resolving into one durable
 * dot. Bars follow the text color; the dot is always ember.
 */
export function BrandMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 120 120"
      role="img"
      aria-label="MemDot"
      className={cn("size-6 text-foreground", className)}
      {...props}
    >
      <rect x="12" y="35" width="58" height="12" rx="6" fill="currentColor" />
      <rect x="12" y="54" width="44" height="12" rx="6" fill="currentColor" fillOpacity="0.72" />
      <rect x="12" y="73" width="30" height="12" rx="6" fill="currentColor" fillOpacity="0.44" />
      <circle cx="92" cy="60" r="16" fill="var(--md-ember)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <BrandMark />
      <span className="font-medium text-h3 tracking-tight">MemDot</span>
    </span>
  );
}

/**
 * The brand loader: the bars shorten in sequence and the dot pulses. Only for the first app load
 * and on-device key creation; everything else uses skeletons.
 */
export function BrandLoader({ label, className }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex flex-col items-center gap-4", className)}
    >
      <svg viewBox="0 0 120 120" aria-hidden="true" className="size-14 text-foreground">
        {[
          { y: 35, w: 58, o: 1, d: "0ms" },
          { y: 54, w: 44, o: 0.72, d: "150ms" },
          { y: 73, w: 30, o: 0.44, d: "300ms" },
        ].map((bar) => (
          <rect
            key={bar.y}
            x="12"
            y={bar.y}
            width={bar.w}
            height="12"
            rx="6"
            fill="currentColor"
            fillOpacity={bar.o}
            className="origin-[12px_center] animate-loader-bar"
            style={{ animationDelay: bar.d, transformBox: "fill-box", transformOrigin: "left" }}
          />
        ))}
        <circle
          cx="92"
          cy="60"
          r="16"
          fill="var(--md-ember)"
          className="animate-loader-dot"
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
      </svg>
      {label && <p className="text-ui text-text-2">{label}</p>}
    </div>
  );
}
