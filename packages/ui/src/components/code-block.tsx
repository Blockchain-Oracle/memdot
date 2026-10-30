import { cn } from "../lib/utils";
import { CopyButton } from "./copy-button";

// Ported from kvnkld/code-block (21st.dev): a language header with copy, numbered lines.

export function CodeBlock({
  lang,
  code,
  className,
}: {
  lang: string;
  code: string;
  className?: string;
}) {
  const lines = code.split("\n");
  return (
    <div
      data-slot="code-block"
      className={cn("overflow-hidden rounded-xl border border-border bg-surface-2", className)}
    >
      <div className="flex h-9 items-center justify-between border-b border-border pr-1 pl-3">
        <span className="eyebrow">{lang}</span>
        <CopyButton value={code} size="icon" label="Copy code" />
      </div>
      <pre className="overflow-x-auto py-3 font-mono text-[13px] leading-[22px]">
        {lines.map((line, i) => (
          <div key={`${i}:${line}`} className="flex">
            <span className="w-10 shrink-0 pr-3 text-right text-text-4 tabular select-none">
              {i + 1}
            </span>
            <code className="pr-4 text-foreground">{line || " "}</code>
          </div>
        ))}
      </pre>
    </div>
  );
}
