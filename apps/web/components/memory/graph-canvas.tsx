"use client";

import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";

export interface CanvasNode {
  id: string;
  name: string;
  weight: number;
}
export interface CanvasLink {
  source: string;
  target: string;
  relation: string | null;
}

type Node = NodeObject<CanvasNode>;
type Link = LinkObject<CanvasNode, CanvasLink>;

const REPULSION = -140;
const LINK_DISTANCE = 60;
const WARMUP_TICKS = 120;
const COOLDOWN_TICKS = 160;
const FIT_PADDING = 48;
const LABEL_PX = 11;
/** Past this zoom every name shows, and relations on their lines. */
const LABELS_AT_SCALE = 1.1;
const RELATIONS_AT_SCALE = 1.8;
const TOUCH_SLOP = 4;
/** A handful of names fits at any size, and shouldn't fill the box with one huge dot. */
const MAX_ZOOM = 3.5;

const radius = (weight: number) => 3 + Math.sqrt(weight) * 1.6;

interface Palette {
  node: string;
  faint: string;
  line: string;
  text: string;
  mark: string;
  surface: string;
  font: string;
}

/** Canvas can't use CSS variables, so the tokens are read once per theme. */
function readPalette(): Palette {
  const root = getComputedStyle(document.documentElement);
  const color = (name: string) => root.getPropertyValue(name).trim();
  return {
    node: color("--md-text-3"),
    faint: color("--md-border"),
    line: color("--md-text-4"),
    text: color("--md-text"),
    mark: color("--md-ember"),
    surface: color("--md-surface-1"),
    font: getComputedStyle(document.body).fontFamily,
  };
}

/** The force layout. A separate module so the library only loads on this page. */
export default function GraphCanvas({
  nodes,
  links,
  width,
  height,
  selected,
  highlighted,
  onSelect,
}: {
  nodes: CanvasNode[];
  links: CanvasLink[];
  width: number;
  height: number;
  selected: string | null;
  /** Set: everything else fades, for a search. */
  highlighted: Set<string> | null;
  onSelect: (id: string | null) => void;
}) {
  const graph = useRef<ForceGraphMethods<Node, Link> | undefined>(undefined);
  const { resolvedTheme } = useTheme();
  const [reduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [palette, setPalette] = useState(readPalette);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tokens change with the theme
  useEffect(() => setPalette(readPalette()), [resolvedTheme]);

  // The library swaps a link's ids for its nodes in place, so it gets its own copies.
  const data = useMemo(
    () => ({
      nodes: nodes.map((node) => ({ ...node })) as Node[],
      links: links.map((link) => ({ ...link })) as Link[],
    }),
    [nodes, links],
  );
  const neighbours = useMemo(() => {
    const near = new Set<string>();
    if (!selected) return near;
    for (const link of links) {
      if (link.source === selected) near.add(link.target);
      if (link.target === selected) near.add(link.source);
    }
    return near;
  }, [links, selected]);

  useEffect(() => {
    graph.current?.d3Force("charge")?.strength?.(REPULSION);
    graph.current?.d3Force("link")?.distance?.(LINK_DISTANCE);
    graph.current?.d3ReheatSimulation();
  }, []);

  // Opening the panel narrows the box, which would otherwise cut off whatever's near the edge.
  const firstWidth = useRef(width);
  useEffect(() => {
    if (width === firstWidth.current) return;
    firstWidth.current = width;
    graph.current?.zoomToFit(reduced ? 0 : 300, FIT_PADDING);
  }, [width, reduced]);

  const faded = (id: string) =>
    highlighted
      ? !highlighted.has(id)
      : Boolean(selected) && id !== selected && !neighbours.has(id);

  return (
    <ForceGraph2D<CanvasNode, CanvasLink>
      ref={graph}
      graphData={data}
      width={width}
      height={height}
      backgroundColor="rgba(0,0,0,0)"
      warmupTicks={reduced ? WARMUP_TICKS * 2 : 0}
      cooldownTicks={reduced ? 0 : COOLDOWN_TICKS}
      onEngineStop={() => graph.current?.zoomToFit(reduced ? 0 : 300, FIT_PADDING)}
      maxZoom={MAX_ZOOM}
      nodeRelSize={1}
      nodeVal={(node) => radius(node.weight) ** 2}
      onNodeClick={(node) => onSelect(String(node.id))}
      onBackgroundClick={() => onSelect(null)}
      nodeCanvasObject={(node, ctx, scale) => {
        const r = radius(node.weight);
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        const id = String(node.id);
        const isFaded = faded(id);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = id === selected ? palette.mark : isFaded ? palette.faint : palette.node;
        ctx.fill();
        if (!isFaded && (scale > LABELS_AT_SCALE || node.weight > 1 || id === selected)) {
          ctx.font = `${LABEL_PX / scale}px ${palette.font}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = palette.text;
          ctx.fillText(node.name, x, y + r + 2 / scale);
        }
      }}
      nodePointerAreaPaint={(node, color, ctx) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x ?? 0, node.y ?? 0, radius(node.weight) + TOUCH_SLOP, 0, Math.PI * 2);
        ctx.fill();
      }}
      linkColor={(link) => (link.relation ? palette.node : palette.line)}
      linkWidth={(link) => (link.relation ? 1.5 : 1)}
      linkLineDash={(link) => (link.relation ? null : [2, 2])}
      linkDirectionalArrowLength={(link) => (link.relation ? 3 : 0)}
      linkDirectionalArrowRelPos={0.9}
      linkCanvasObjectMode={() => "after"}
      linkCanvasObject={(link, ctx, scale) => {
        const from = link.source as Node;
        const to = link.target as Node;
        if (!link.relation || scale < RELATIONS_AT_SCALE) return;
        if (faded(String(from.id)) || faded(String(to.id))) return;
        const x = ((from.x ?? 0) + (to.x ?? 0)) / 2;
        const y = ((from.y ?? 0) + (to.y ?? 0)) / 2;
        ctx.font = `${(LABEL_PX - 1) / scale}px ${palette.font}`;
        const box = ctx.measureText(link.relation).width + 4 / scale;
        ctx.fillStyle = palette.surface;
        ctx.fillRect(x - box / 2, y - 7 / scale, box, 14 / scale);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = palette.node;
        ctx.fillText(link.relation, x, y);
      }}
    />
  );
}
