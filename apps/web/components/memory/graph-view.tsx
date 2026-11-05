"use client";

import type { Memory, Namespace } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@memdot/ui/components/empty";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@memdot/ui/components/select";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Switch } from "@memdot/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@memdot/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, MinusIcon, SearchIcon, XIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { describeError } from "@/lib/errors";
import { formatNumber } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { MemorySheet } from "./memory-sheet";

const GraphCanvas = dynamic(() => import("./graph-canvas"), {
  ssr: false,
  loading: () => <Skeleton className="size-full" />,
});

const VIEWS = [
  { value: "graph", label: "Graph" },
  { value: "list", label: "List" },
];
const ALL_RELATIONS = "all";
const TOGETHER = "together";
const CANVAS_HEIGHT = 560;
/** Each one is a read, so the panel opens the first few and counts the rest. */
const PANEL_MEMORIES = 8;

/**
 * Fills its width. The canvas needs real numbers. A callback ref, since the box only exists once the
 * graph has loaded, and again each time the view switches back.
 */
function useWidth() {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  return { ref: setBox, width };
}

function EntityPanel({
  namespace,
  name,
  memoryIds,
  connections,
  onSelect,
  onClose,
}: {
  namespace: Namespace;
  name: string;
  memoryIds: string[];
  connections: { id: string; name: string; relation: string | null; outgoing: boolean }[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const memdot = useMemDot();
  const [open, setOpen] = useState<Memory | null>(null);
  const shown = memoryIds.slice(0, PANEL_MEMORIES);
  const memories = useQuery({
    queryKey: ["memories", namespace.id, "graph-panel", shown],
    queryFn: () => Promise.all(shown.map((id) => memdot.memories.get(id))),
  });
  return (
    <aside className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-h3">{name}</h2>
          <span className="text-ui-sm text-text-3">
            In {formatNumber(memoryIds.length)} {memoryIds.length === 1 ? "memory" : "memories"}
          </span>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-foreground"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {connections.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Connected to</span>
          <ul className="flex flex-col gap-1">
            {connections.map((link) => (
              <li key={`${link.id}:${link.relation}:${link.outgoing}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui-sm hover:bg-surface-2"
                  onClick={() => onSelect(link.id)}
                >
                  {link.relation ? (
                    <span className="shrink-0 font-mono text-text-3">
                      {link.outgoing ? link.relation : `${link.relation} of`}
                    </span>
                  ) : (
                    <MinusIcon
                      className="size-3 shrink-0 text-text-3"
                      aria-label="Mentioned together"
                    />
                  )}
                  <span className="truncate">{link.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="eyebrow">Memories</span>
        {memories.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : memories.error ? (
          <p className="text-ui-sm text-danger-fg">{describeError(memories.error).title}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {memories.data.map((memory) => (
              <li key={memory.id}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-surface-2"
                  onClick={() => setOpen(memory)}
                >
                  {memory.memory}
                </button>
              </li>
            ))}
          </ul>
        )}
        {memoryIds.length > shown.length && (
          <span className="px-2 text-ui-sm text-text-3">
            And {formatNumber(memoryIds.length - shown.length)} more
          </span>
        )}
      </div>
      <MemorySheet
        memory={open}
        namespace={namespace}
        onOpenChange={(next) => !next && setOpen(null)}
      />
    </aside>
  );
}

/** Who and what the memories mention, and how those connect. Built from what's stored. */
export function GraphView({ namespace }: { namespace: Namespace }) {
  const memdot = useMemDot();
  const id = useId();
  const { ref, width } = useWidth();
  const panel = useRef<HTMLDivElement>(null);
  const [view, setView] = useState("graph");
  const [search, setSearch] = useState("");
  const [relation, setRelation] = useState(ALL_RELATIONS);
  const [hideLoose, setHideLoose] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const graph = useQuery({
    queryKey: ["memories", namespace.id, "graph"],
    queryFn: () => memdot.memories.graph({ namespaceId: namespace.id }),
  });

  const relations = useMemo(() => {
    const names = new Set<string>();
    for (const edge of graph.data?.edges ?? []) if (edge.relation) names.add(edge.relation);
    return [...names].sort();
  }, [graph.data]);

  const edges = useMemo(
    () =>
      (graph.data?.edges ?? []).filter((edge) =>
        relation === ALL_RELATIONS
          ? true
          : relation === TOGETHER
            ? edge.relation === null
            : edge.relation === relation,
      ),
    [graph.data, relation],
  );
  const nodes = useMemo(() => {
    const linked = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    const hideUnlinked = hideLoose || relation !== ALL_RELATIONS;
    return (graph.data?.nodes ?? [])
      .filter((node) => !hideUnlinked || linked.has(node.id))
      .map((node) => ({ id: node.id, name: node.name, weight: node.memories.length }));
  }, [graph.data, edges, hideLoose, relation]);
  const links = useMemo(
    () => edges.map(({ source, target, relation: named }) => ({ source, target, relation: named })),
    [edges],
  );
  const names = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);

  const highlighted = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return null;
    return new Set(nodes.filter((node) => node.name.toLowerCase().includes(term)).map((n) => n.id));
  }, [nodes, search]);

  const chosen = graph.data?.nodes.find((node) => node.id === selected);
  const connections = useMemo(
    () =>
      edges.flatMap((edge) => {
        if (edge.source === selected) {
          return [
            {
              id: edge.target,
              name: names.get(edge.target) ?? edge.target,
              relation: edge.relation,
              outgoing: true,
            },
          ];
        }
        if (edge.target === selected) {
          return [
            {
              id: edge.source,
              name: names.get(edge.source) ?? edge.source,
              relation: edge.relation,
              outgoing: false,
            },
          ];
        }
        return [];
      }),
    [edges, selected, names],
  );

  // On a phone the panel is under the canvas, where a tap wouldn't otherwise show anything.
  useEffect(() => {
    if (selected && window.innerWidth < 1024) {
      panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selected]);

  if (graph.isPending) return <Skeleton className="h-96 w-full rounded-xl" />;
  if (graph.error) {
    return (
      <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui text-danger-fg">
        {describeError(graph.error).title}
      </p>
    );
  }
  if (graph.data.nodes.length === 0) {
    return (
      <Empty className="rounded-xl border border-dashed border-border-strong py-16">
        <EmptyHeader>
          <EmptyTitle>Nothing to connect yet</EmptyTitle>
          <EmptyDescription>
            The names in a memory and how they relate are picked out when it's added with a model.
            Memories stored as written don't have any.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl options={VIEWS} label="View" value={view} onValueChange={setView} />
          <div className="relative min-w-40 flex-1 sm:flex-none">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              aria-label="Find a name"
              placeholder="Find a name…"
              className="pl-9"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select value={relation} onValueChange={setRelation}>
            <SelectTrigger aria-label="Relation" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_RELATIONS}>Every connection</SelectItem>
              <SelectItem value={TOGETHER}>Mentioned together</SelectItem>
              {relations.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Switch id={`${id}-loose`} checked={hideLoose} onCheckedChange={setHideLoose} />
          <Label htmlFor={`${id}-loose`}>Hide unconnected</Label>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className={chosen ? "min-w-0" : "min-w-0 lg:col-span-2"}>
          {view === "graph" ? (
            <div
              ref={ref}
              role="img"
              aria-label={`${nodes.length} names and ${links.length} connections. The list view has the same in text.`}
              className="overflow-hidden rounded-xl border border-border bg-surface-1"
              style={{ height: CANVAS_HEIGHT }}
            >
              {width > 0 && (
                <GraphCanvas
                  nodes={nodes}
                  links={links}
                  width={width}
                  height={CANVAS_HEIGHT}
                  selected={selected}
                  highlighted={highlighted}
                  onSelect={setSelected}
                />
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-surface-1">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From</TableHead>
                    <TableHead>Connection</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Memories</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {edges
                    .filter(
                      (edge) =>
                        !highlighted ||
                        highlighted.has(edge.source) ||
                        highlighted.has(edge.target),
                    )
                    .map((edge) => (
                      <TableRow key={`${edge.source}:${edge.relation}:${edge.target}`}>
                        <TableCell className="max-w-40 truncate">
                          <button
                            type="button"
                            className="underline-offset-4 hover:underline"
                            onClick={() => setSelected(edge.source)}
                          >
                            {names.get(edge.source) ?? edge.source}
                          </button>
                        </TableCell>
                        <TableCell>
                          {edge.relation ? (
                            <Badge variant="outline" className="gap-1 font-mono font-normal">
                              {edge.relation} <ArrowRightIcon className="size-3" />
                            </Badge>
                          ) : (
                            <span className="text-ui-sm text-text-3">Together</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-40 truncate">
                          <button
                            type="button"
                            className="underline-offset-4 hover:underline"
                            onClick={() => setSelected(edge.target)}
                          >
                            {names.get(edge.target) ?? edge.target}
                          </button>
                        </TableCell>
                        <TableCell className="hidden text-right font-mono text-ui-sm tabular sm:table-cell">
                          {formatNumber(edge.memories.length)}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="mt-2 text-ui-sm text-text-3">
            {formatNumber(nodes.length)} {nodes.length === 1 ? "name" : "names"},{" "}
            {formatNumber(links.length)} {links.length === 1 ? "connection" : "connections"}, from{" "}
            {formatNumber(graph.data.memoriesRead)}{" "}
            {graph.data.memoriesRead === 1 ? "memory" : "memories"}
            {graph.data.truncated && ", the newest ones only"}.
            {namespace.mode === "private" && " Built on this device."}
          </p>
        </div>
        {chosen && (
          <div ref={panel} className="min-w-0">
            <EntityPanel
              key={chosen.id}
              namespace={namespace}
              name={chosen.name}
              memoryIds={chosen.memories}
              connections={connections}
              onSelect={setSelected}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
