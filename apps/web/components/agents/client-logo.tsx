import { cn } from "@memdot/ui/lib/utils";
import { BotIcon } from "lucide-react";

/** Matched on what a client calls itself: this helps people recognise it, and proves nothing. */
const LOGOS: { match: RegExp; src: string; invert?: boolean }[] = [
  { match: /claude/i, src: "/agents/claude-color.svg" },
  { match: /cursor/i, src: "/agents/cursor.svg", invert: true },
  { match: /codex|chatgpt|openai/i, src: "/agents/openai.svg", invert: true },
];

export function ClientLogo({
  label,
  client,
  className,
}: {
  label: string;
  client: string;
  className?: string;
}) {
  const logo = LOGOS.find((candidate) => candidate.match.test(`${label} ${client}`));
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2",
        className,
      )}
    >
      {logo ? (
        // biome-ignore lint/performance/noImgElement: a small local SVG, sized by CSS.
        <img src={logo.src} alt="" className={cn("size-1/2", logo.invert && "dark:invert")} />
      ) : (
        <BotIcon className="size-1/2 text-text-2" aria-hidden="true" />
      )}
    </span>
  );
}
