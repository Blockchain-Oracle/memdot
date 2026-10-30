"use client";

import { cva, type VariantProps } from "class-variance-authority";
import {
  Children,
  createContext,
  type HTMLAttributes,
  isValidElement,
  type ReactElement,
  useContext,
} from "react";
import { cn } from "../lib/utils";

type PartitionBarContextType = {
  total: number;
  size: VariantProps<typeof partitionBarVariants>["size"];
};

const PartitionBarCtxt = createContext<PartitionBarContextType | null>(null);

function usePartitionBarContext(): PartitionBarContextType {
  const context = useContext(PartitionBarCtxt);
  if (!context) {
    throw new Error("usePartitionBarContext must be used within a PartitionBarProvider");
  }
  return context;
}

//////////////////////////////////////////////////////////////////////////////

const partitionBarVariants = cva("flex flex-row", {
  variants: {
    size: {
      sm: "text-xs",
      md: "text-sm",
      lg: "text-md",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

interface PartitionBar
  extends HTMLAttributes<HTMLUListElement>,
    VariantProps<typeof partitionBarVariants> {
  children?: ReactElement<PartitionBarSegment> | ReactElement<PartitionBarSegment>[];
  gap?: number;
}

export function PartitionBar({ children, className, gap = 1, size, ...props }: PartitionBar) {
  const total = Children.toArray(children).reduce<number>(
    (sum, child) =>
      isValidElement(child) ? sum + ((child.props as PartitionBarSegment).num || 0) : sum,
    0,
  );

  return (
    <PartitionBarCtxt.Provider value={{ total, size }}>
      <ul
        className={cn("w-full", partitionBarVariants({ size }), className)}
        style={{
          gap: `${gap * 4}px`,
        }}
        {...props}
      >
        {children}
      </ul>
    </PartitionBarCtxt.Provider>
  );
}

////////////////////////////////////////////////////////////////////////////

const partitionBarLineVariants = cva("", {
  variants: {
    variant: {
      default: "bg-foreground",
      secondary: "bg-text-3",
      muted: "bg-border-strong",
      ember: "bg-ember",
      ok: "bg-ok",
      destructive: "bg-danger",
      outline: "border border-border bg-surface-2",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

const partitionBarTitleVariants = cva("", {
  variants: {
    variant: {
      default: "text-foreground",
      secondary: "text-text-2",
      muted: "text-text-3",
      ember: "text-foreground",
      ok: "text-foreground",
      destructive: "text-danger-fg",
      outline: "text-text-3",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

interface PartitionBarSegment
  extends HTMLAttributes<HTMLLIElement>,
    VariantProps<typeof partitionBarLineVariants> {
  children?: React.ReactNode;
  num?: number;
  variant?: VariantProps<typeof partitionBarLineVariants>["variant"];
  alignment?: "left" | "center" | "right";
}

export function PartitionBarSegment({
  children,
  num = 0,
  variant = "default",
  alignment = "center",
  className,
  ...props
}: PartitionBarSegment) {
  const { total, size } = usePartitionBarContext();

  const widthPercent = total > 0 ? (num / total) * 100 : 0;

  return (
    <li
      className="flex flex-col min-w-0"
      style={{
        flexBasis: `${widthPercent}%`,
        flexGrow: 0,
        flexShrink: 0,
      }}
      {...props}
    >
      <div
        className={cn(
          partitionBarLineVariants({ variant }),
          "w-full shrink-0 rounded-xs",
          size === "sm" ? "h-1.5" : size === "md" ? "h-2" : "h-3",
          className,
        )}
      />
      <div
        className={cn(
          partitionBarTitleVariants({ variant }),
          "w-full whitespace-normal flex flex-col",
          size === "sm" ? "mt-1.5" : size === "md" ? "mt-2" : "mt-3",
          alignment === "left" && "items-start",
          alignment === "center" && "items-center",
          alignment === "right" && "items-end",
        )}
      >
        {children}
      </div>
    </li>
  );
}

/////////////////////////////////////////////////////////////////////////////

interface PartitionBarSegmentTitle extends HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function PartitionBarSegmentTitle({ children, className }: PartitionBarSegmentTitle) {
  return <div className={cn("eyebrow w-fit", className)}>{children}</div>;
}

interface PartitionBarSegmentValue extends HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function PartitionBarSegmentValue({ children, className }: PartitionBarSegmentValue) {
  return (
    <div className={cn("w-fit font-mono text-mono tabular text-text-2", className)}>{children}</div>
  );
}
