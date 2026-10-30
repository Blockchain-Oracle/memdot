"use client";

import { CheckIcon, LoaderCircle } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

// Ported from originui/stepper (21st.dev): context-driven steps, horizontal or vertical.

type StepState = "active" | "completed" | "inactive";

type StepperContextValue = {
  activeStep: number;
  setActiveStep: (step: number) => void;
  orientation: "horizontal" | "vertical";
};

type StepItemContextValue = {
  step: number;
  state: StepState;
  isDisabled: boolean;
  isLoading: boolean;
};

const StepperContext = React.createContext<StepperContextValue | undefined>(undefined);
const StepItemContext = React.createContext<StepItemContextValue | undefined>(undefined);

function useStepper() {
  const context = React.useContext(StepperContext);
  if (!context) throw new Error("useStepper must be used within a Stepper");
  return context;
}

function useStepItem() {
  const context = React.useContext(StepItemContext);
  if (!context) throw new Error("useStepItem must be used within a StepperItem");
  return context;
}

function Stepper({
  defaultValue = 0,
  value,
  onValueChange,
  orientation = "horizontal",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  defaultValue?: number;
  value?: number;
  onValueChange?: (value: number) => void;
  orientation?: "horizontal" | "vertical";
}) {
  const [internal, setInternal] = React.useState(defaultValue);
  const setActiveStep = React.useCallback(
    (step: number) => {
      if (value === undefined) setInternal(step);
      onValueChange?.(step);
    },
    [value, onValueChange],
  );
  return (
    <StepperContext value={{ activeStep: value ?? internal, setActiveStep, orientation }}>
      <div
        data-slot="stepper"
        data-orientation={orientation}
        className={cn(
          "group/stepper inline-flex data-[orientation=horizontal]:w-full data-[orientation=horizontal]:flex-row data-[orientation=vertical]:flex-col",
          className,
        )}
        {...props}
      />
    </StepperContext>
  );
}

function StepperItem({
  step,
  completed = false,
  disabled = false,
  loading = false,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  step: number;
  completed?: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { activeStep } = useStepper();
  const state: StepState =
    completed || step < activeStep ? "completed" : activeStep === step ? "active" : "inactive";
  const isLoading = loading && step === activeStep;
  return (
    <StepItemContext value={{ step, state, isDisabled: disabled, isLoading }}>
      <div
        data-slot="stepper-item"
        data-state={state}
        {...(isLoading ? { "data-loading": true } : {})}
        className={cn(
          "group/step flex items-center group-data-[orientation=horizontal]/stepper:flex-row group-data-[orientation=vertical]/stepper:flex-col",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </StepItemContext>
  );
}

function StepperTrigger({
  asChild = false,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const { setActiveStep } = useStepper();
  const { step, isDisabled } = useStepItem();
  if (asChild) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      data-slot="stepper-trigger"
      className={cn(
        "inline-flex items-center gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none",
        className,
      )}
      onClick={() => setActiveStep(step)}
      disabled={isDisabled}
      {...props}
    >
      {children}
    </button>
  );
}

function StepperIndicator({ className, ...props }: React.ComponentProps<"div">) {
  const { state, step, isLoading } = useStepItem();
  return (
    <div
      data-slot="stepper-indicator"
      data-state={state}
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-1 font-mono text-[11px] text-text-3 transition-colors duration-(--motion-state)",
        "data-[state=active]:border-foreground data-[state=active]:bg-foreground data-[state=active]:text-background",
        "data-[state=completed]:border-transparent data-[state=completed]:bg-surface-3 data-[state=completed]:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="transition-all group-data-[loading=true]/step:scale-0 group-data-[state=completed]/step:scale-0 group-data-[loading=true]/step:opacity-0 group-data-[state=completed]/step:opacity-0">
        {step}
      </span>
      <CheckIcon
        className="absolute size-3.5 scale-0 opacity-0 transition-all group-data-[state=completed]/step:scale-100 group-data-[state=completed]/step:opacity-100"
        strokeWidth={2}
        aria-hidden="true"
      />
      {isLoading && <LoaderCircle className="absolute size-3.5 animate-spin" aria-hidden="true" />}
    </div>
  );
}

function StepperTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="stepper-title"
      className={cn(
        "text-ui font-medium text-text-3 group-data-[state=active]/step:text-foreground group-data-[state=completed]/step:text-text-2",
        className,
      )}
      {...props}
    />
  );
}

function StepperDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="stepper-description"
      className={cn("text-ui-sm text-text-3", className)}
      {...props}
    />
  );
}

function StepperSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stepper-separator"
      className={cn(
        "m-0.5 bg-border group-data-[orientation=horizontal]/stepper:h-px group-data-[orientation=vertical]/stepper:h-8 group-data-[orientation=horizontal]/stepper:w-full group-data-[orientation=vertical]/stepper:w-px group-data-[orientation=horizontal]/stepper:flex-1 group-data-[state=completed]/step:bg-text-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
};
