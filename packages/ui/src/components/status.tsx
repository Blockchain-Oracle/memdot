import { cva, type VariantProps } from "class-variance-authority";
import { Slot as SlotPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils";

const statusVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-ui-sm transition-colors duration-(--motion-instant)",
  {
    variants: {
      variant: {
        default: "border-border bg-surface-2 text-text-2 **:data-[slot=status-indicator]:bg-text-3",
        ok: "border-ok/25 bg-ok/10 text-ok-fg **:data-[slot=status-indicator]:bg-ok",
        warn: "border-warn/30 bg-warn/10 text-warn-fg **:data-[slot=status-indicator]:bg-warn",
        danger:
          "border-danger/25 bg-danger/10 text-danger-fg **:data-[slot=status-indicator]:bg-danger",
        live: "border-border bg-surface-2 text-text-2 **:data-[slot=status-indicator]:bg-ember",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

interface StatusProps extends VariantProps<typeof statusVariants>, React.ComponentProps<"div"> {
  asChild?: boolean;
}

function Status(props: StatusProps) {
  const { className, variant = "default", asChild, ...rootProps } = props;

  const RootPrimitive = asChild ? SlotPrimitive.Slot : "div";

  return (
    <RootPrimitive
      data-slot="status"
      data-variant={variant}
      {...rootProps}
      className={cn(statusVariants({ variant }), className)}
    />
  );
}

/** The dot. `pulse` is for live or in-flight states only (queued, submitted, renewing). */
function StatusIndicator(props: React.ComponentProps<"div"> & { pulse?: boolean }) {
  const { className, pulse = false, ...indicatorProps } = props;

  return (
    <div
      data-slot="status-indicator"
      {...indicatorProps}
      className={cn(
        "relative flex size-1.5 shrink-0 rounded-full",
        pulse &&
          "before:absolute before:-inset-0.5 before:animate-ping before:rounded-full before:bg-inherit before:opacity-60 motion-reduce:before:hidden",
        className,
      )}
    />
  );
}

function StatusLabel(props: React.ComponentProps<"div">) {
  const { className, ...labelProps } = props;

  return <div data-slot="status-label" {...labelProps} className={cn("leading-none", className)} />;
}

export { Status, StatusIndicator, StatusLabel, statusVariants };
