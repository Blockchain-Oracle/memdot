"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

// Ported from unlumen/animate-count (21st.dev): the old value rolls up and out, the new one in.
// Numbers tick instead of jumping (design §1.6); reduced motion swaps without movement.

const DURATION_S = 0.45;
const EASING = [0.23, 0.88, 0.26, 0.92] as const;

export function AnimateCount({
  value,
  format = (n) => n.toLocaleString("en-US"),
  className,
}: {
  value: number;
  format?: (value: number) => string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [prev, setPrev] = useState<number | null>(null);
  const [shown, setShown] = useState(value);
  const last = useRef(value);

  useEffect(() => {
    if (last.current === value) return;
    if (!reduced) setPrev(last.current);
    last.current = value;
    setShown(value);
  }, [value, reduced]);

  return (
    <span className={cn("inline-grid tabular-nums [&>*]:col-start-1 [&>*]:row-start-1", className)}>
      <AnimatePresence initial={false}>
        {prev !== null && prev !== shown && (
          <motion.span
            key={`exit-${prev}-${shown}`}
            aria-hidden="true"
            initial={{ opacity: 1, y: 0 }}
            animate={{ opacity: 0, y: "-0.6em" }}
            transition={{ duration: DURATION_S, ease: EASING }}
            onAnimationComplete={() => setPrev(null)}
          >
            {format(prev)}
          </motion.span>
        )}
      </AnimatePresence>
      <motion.span
        key={`enter-${shown}`}
        initial={reduced || prev === null ? false : { opacity: 0, y: "0.4em" }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DURATION_S, ease: EASING }}
      >
        {format(shown)}
      </motion.span>
    </span>
  );
}
