// biome-ignore-all lint/a11y/useSemanticElements: virtualized rows are absolutely positioned, so the table is ARIA roles on divs (the TanStack Virtual pattern)
// biome-ignore-all lint/a11y/useFocusableInteractive: header and cell roles are not interactive; rows carry tabIndex
"use client";

import type { Memory, Namespace, ScoredMemory } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@memdot/ui/components/empty";
import {
  type Filter,
  FilterBar,
  type FilterFieldDef,
} from "@memdot/ui/components/filter-token-bar";
import { Input } from "@memdot/ui/components/input";
import { Kbd } from "@memdot/ui/components/kbd";
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { cn } from "@memdot/ui/lib/utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { FileIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { subscribeToModelDownload } from "@/lib/device-embedder";
import { describeError } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { AddMemorySheet } from "./add-memory-sheet";
import { MemorySheet } from "./memory-sheet";

const PAGE = 50;
const ROW_HEIGHT = 60;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULTS = 50;
/** By the table's own width, since the namespace column takes its share too. */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_56px] items-center gap-x-3 @xl:grid-cols-[minmax(0,1fr)_96px_64px] @3xl:grid-cols-[minmax(0,1fr)_96px_96px_96px_64px]";

const IS_OPERATORS = [
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
];
const DAY_MS = 24 * 60 * 60 * 1000;
const SINCE = [
  { value: "1", label: "the last day" },
  { value: "7", label: "the last 7 days" },
  { value: "30", label: "the last 30 days" },
];
const MODES = [
  { value: "hybrid", label: "Meaning + words" },
  { value: "keyword", label: "Exact words" },
];

const COLUMN: Record<string, string> = {
  user: "user_id",
  agent: "agent_id",
  run: "run_id",
  category: "categories",
};

/** The filter tokens as the API's filter language. */
function toFilters(tokens: Filter[]): Record<string, unknown> | undefined {
  const conditions = tokens.flatMap((token): Record<string, unknown>[] => {
    if (token.values.length === 0) return [];
    if (token.field === "created") {
      const days = Number(token.values[0]);
      return [{ created_at: { gte: new Date(Date.now() - days * DAY_MS).toISOString() } }];
    }
    if (token.field === "source") return [{ source_object_id: "*" }];
    const column = COLUMN[token.field];
    if (!column) return [];
    const match = { [column]: { in: token.values } };
    return token.operator === "is_not" ? [{ NOT: [match] }] : [match];
  });
  if (conditions.length === 0) return undefined;
  return { AND: conditions };
}

function Relevance({ score }: { score: number }) {
  return (
    <span className="font-mono text-ui-sm text-text-2 tabular" title="Relevance, 0 to 1">
      {score.toFixed(2)}
    </span>
  );
}

function ModelDownload() {
  const [percent, setPercent] = useState<number | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeToModelDownload(setPercent);
    return () => {
      unsubscribe();
    };
  }, []);
  if (percent === null) return null;
  return (
    <p className="flex items-center gap-2 text-ui-sm text-text-3">
      <Spinner /> Downloading the on-device search model, once: {Math.round(percent)}%
    </p>
  );
}

/** Search, filter tokens, and every memory in a namespace in a virtualized table. */
export function MemoryExplorer({
  namespace,
  initialFilters = [],
}: {
  namespace: Namespace;
  initialFilters?: Filter[];
}) {
  const memdot = useMemDot();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [tokens, setTokens] = useState<Filter[]>(initialFilters);
  const [open, setOpen] = useState<Memory | null>(null);
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  // "/" jumps to search from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || target.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filters = useMemo(() => toFilters(tokens), [tokens]);
  const list = useInfiniteQuery({
    queryKey: ["memories", namespace.id, "list", filters],
    enabled: !debounced,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      memdot.memories.list({
        namespaceId: namespace.id,
        pageSize: PAGE,
        ...(filters ? { filters } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const search = useQuery({
    queryKey: ["memories", namespace.id, "search", debounced, mode, filters],
    enabled: Boolean(debounced),
    queryFn: () =>
      memdot.memories.search(debounced, {
        namespaceId: namespace.id,
        topK: SEARCH_RESULTS,
        mode: mode as "hybrid" | "keyword",
        ...(filters ? { filters } : {}),
      }),
  });
  const entities = useQuery({
    queryKey: ["entities", namespace.id],
    queryFn: () => memdot.memories.entities({ namespaceId: namespace.id }),
  });

  const categories = useQuery({
    queryKey: ["memories", namespace.id, "categories"],
    queryFn: () => memdot.memories.categories(namespace.id),
  });

  const fields = useMemo<FilterFieldDef[]>(() => {
    const options = (type: string) =>
      (entities.data ?? [])
        .filter((entity) => entity.type === type)
        .map((entity) => ({ value: entity.id, label: entity.id }));
    return [
      { id: "user", label: "User", operators: IS_OPERATORS, options: options("user") },
      { id: "agent", label: "Agent", operators: IS_OPERATORS, options: options("agent") },
      { id: "run", label: "Run", operators: IS_OPERATORS, options: options("run") },
      {
        id: "category",
        label: "Category",
        operators: IS_OPERATORS,
        options: (categories.data?.categories ?? []).map(({ name, count }) => ({
          value: name,
          label: `${name} (${count})`,
        })),
      },
      {
        id: "created",
        label: "Added",
        operators: [{ value: "in", label: "in" }],
        options: SINCE,
      },
      {
        id: "source",
        label: "Source",
        operators: [{ value: "is", label: "is" }],
        options: [{ value: "file", label: "a file" }],
      },
    ];
  }, [entities.data, categories.data]);

  const searching = Boolean(debounced);
  const pending = searching ? search.isPending : list.isPending;
  const error = searching ? search.error : list.error;
  const rows: (Memory | ScoredMemory)[] = useMemo(
    () => (searching ? (search.data ?? []) : (list.data?.pages.flatMap((p) => p.results) ?? [])),
    [searching, search.data, list.data],
  );
  const total = list.data?.pages[0]?.count;

  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    setScrollMargin(bodyRef.current?.offsetTop ?? 0);
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index;
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list;
  useEffect(() => {
    if (lastIndex === undefined || searching || !hasNextPage || isFetchingNextPage) return;
    if (lastIndex >= rows.length - 5) void fetchNextPage();
  }, [lastIndex, rows.length, searching, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const nothingYet = !searching && !filters && !pending && !error && rows.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
            aria-hidden="true"
          />
          <Input
            ref={input}
            type="search"
            value={query}
            aria-label="Search memories"
            placeholder="Search by meaning…"
            className="pr-10 pl-9"
            onChange={(event) => setQuery(event.target.value)}
          />
          {!query && (
            <Kbd className="absolute top-1/2 right-2 hidden -translate-y-1/2 sm:inline-flex">/</Kbd>
          )}
        </div>
        <Button onClick={() => setAdding(true)}>
          <PlusIcon data-icon="inline-start" /> Add memory
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          fields={fields}
          value={tokens}
          onChange={setTokens}
          aria-label="Filter memories"
          addLabel="Filter"
        />
        {searching && (
          <SegmentedControl
            options={MODES}
            label="How to search"
            value={mode}
            onValueChange={setMode}
          />
        )}
      </div>
      {namespace.mode === "private" && <ModelDownload />}

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui text-danger-fg">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {describeError(error).title}
            {describeError(error).requestId && (
              <span className="block font-mono text-ui-sm opacity-80">
                Request {describeError(error).requestId}
              </span>
            )}
          </span>
        </div>
      ) : nothingYet ? (
        <Empty className="rounded-xl border border-dashed border-border-strong py-16">
          <EmptyHeader>
            <EmptyTitle>Nothing remembered yet</EmptyTitle>
            <EmptyDescription>
              {namespace.mode === "private"
                ? "Add a fact here. Scripts and agents reach this namespace through the SDK, unlocked with your key."
                : "Add a fact here, or point an agent at this namespace with an API key."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setAdding(true)}>
              <PlusIcon data-icon="inline-start" /> Add the first memory
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div
          role="table"
          aria-label="Memories"
          className="rounded-xl border border-border bg-surface-1"
        >
          <div role="row" className={cn(GRID, "eyebrow border-b border-border px-4 py-2.5")}>
            <span role="columnheader">
              {searching
                ? pending
                  ? "Searching…"
                  : `${rows.length} ${rows.length === 1 ? "match" : "matches"}`
                : total !== undefined
                  ? `${total.toLocaleString("en-US")} ${total === 1 ? "memory" : "memories"}`
                  : "Memories"}
            </span>
            <span role="columnheader" className="hidden @xl:block">
              User
            </span>
            <span role="columnheader" className="hidden @3xl:block">
              Agent
            </span>
            <span role="columnheader" className="hidden @3xl:block">
              Run
            </span>
            <span role="columnheader" className="text-right">
              {searching ? "Score" : "Added"}
            </span>
          </div>
          {pending ? (
            <div className="flex flex-col gap-px p-2">
              {[0, 1, 2, 3].map((key) => (
                <Skeleton key={key} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-ui text-text-3">
              {searching ? "No memory matches that." : "No memory matches these filters."}
            </p>
          ) : (
            <div ref={bodyRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((item) => {
                const memory = rows[item.index] as Memory | ScoredMemory;
                return (
                  <div
                    key={memory.id}
                    role="row"
                    tabIndex={0}
                    aria-label={memory.memory}
                    onClick={() => setOpen(memory)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpen(memory);
                      }
                    }}
                    className={cn(
                      GRID,
                      "absolute top-0 left-0 w-full cursor-pointer border-b border-border px-4 last:border-0 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none",
                    )}
                    style={{
                      height: ROW_HEIGHT,
                      transform: `translateY(${item.start - scrollMargin}px)`,
                    }}
                  >
                    <span role="cell" className="flex min-w-0 items-center gap-2">
                      {memory.source?.objectId && (
                        <FileIcon
                          className="size-3.5 shrink-0 text-text-3"
                          aria-label="From a file"
                        />
                      )}
                      <span className="line-clamp-2 text-ui">{memory.memory}</span>
                    </span>
                    <span
                      role="cell"
                      className="hidden truncate font-mono text-ui-sm text-text-2 @xl:block"
                    >
                      {memory.userId ?? "—"}
                    </span>
                    <span
                      role="cell"
                      className="hidden truncate font-mono text-ui-sm text-text-2 @3xl:block"
                    >
                      {memory.agentId ?? "—"}
                    </span>
                    <span
                      role="cell"
                      className="hidden truncate font-mono text-ui-sm text-text-2 @3xl:block"
                    >
                      {memory.runId ?? "—"}
                    </span>
                    <span role="cell" className="text-right text-ui-sm text-text-3">
                      {"score" in memory ? (
                        <Relevance score={memory.score} />
                      ) : (
                        formatRelative(memory.createdAt, true)
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <MemorySheet
        memory={open}
        namespace={namespace}
        onOpenChange={(next) => !next && setOpen(null)}
      />
      <AddMemorySheet namespace={namespace} open={adding} onOpenChange={setAdding} />
    </div>
  );
}
