import { AnimateCount } from "@memdot/ui/components/animate-count";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { cn } from "@memdot/ui/lib/utils";

/** A KPI: eyebrow label, a number that rolls, one line beneath. */
export function Stat({
  label,
  value,
  format,
  hint,
  className,
}: {
  label: string;
  value: number | undefined;
  format?: (value: number) => string;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 bg-surface-1 p-4 shadow-card", className)}>
      <span className="eyebrow">{label}</span>
      {value === undefined ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <AnimateCount value={value} format={format} className="text-h1 font-normal" />
      )}
      {hint && <span className="text-ui-sm text-text-3">{hint}</span>}
    </div>
  );
}

/** Stats in one bordered strip with hairline dividers. */
export function StatRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
      {children}
    </div>
  );
}
