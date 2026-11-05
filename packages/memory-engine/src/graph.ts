/** Two things a memory says are connected, in the words it used. */
export interface MemoryRelation {
  source: string;
  relation: string;
  target: string;
}

/** What the graph needs from a memory, wherever it was read: the server's row or this device. */
export interface GraphMemory {
  id: string;
  entities?: string[] | null | undefined;
  relations?: MemoryRelation[] | null | undefined;
}

export interface GraphNode {
  /** The name, normalized, so "Acme" and "acme" are one thing. */
  id: string;
  /** The name as it was first written. */
  name: string;
  /** The memories that mention it. */
  memories: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Null when two things were only mentioned together. */
  relation: string | null;
  memories: string[];
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A memory naming more than this is a list, and linking every pair in it says nothing. */
const MAX_MENTIONED_TOGETHER = 8;

const normalizeName = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Entities and relations out of memories. There's no graph database behind this: it's derived from
 * what's stored, so it's the same in both modes and can't drift from the memories it describes.
 */
export function buildGraph(memories: GraphMemory[]): MemoryGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const node = (name: string, memoryId: string): string | null => {
    const id = normalizeName(name);
    if (!id) return null;
    const known = nodes.get(id);
    if (known) {
      if (!known.memories.includes(memoryId)) known.memories.push(memoryId);
    } else {
      nodes.set(id, { id, name: name.trim(), memories: [memoryId] });
    }
    return id;
  };

  const edge = (source: string, target: string, relation: string | null, memoryId: string) => {
    if (source === target) return;
    // Direction carries meaning in a relation. "Mentioned together" has none, so one edge covers both.
    const [from, to] = relation === null && source > target ? [target, source] : [source, target];
    const key = JSON.stringify([from, to, relation]);
    const known = edges.get(key);
    if (known) {
      if (!known.memories.includes(memoryId)) known.memories.push(memoryId);
    } else {
      edges.set(key, { source: from, target: to, relation, memories: [memoryId] });
    }
  };

  for (const memory of memories) {
    const linked = new Set<string>();
    for (const { source, relation, target } of memory.relations ?? []) {
      const from = node(source, memory.id);
      const to = node(target, memory.id);
      const label = relation.trim();
      if (!from || !to || !label) continue;
      edge(from, to, label, memory.id);
      linked.add(JSON.stringify([from, to].sort()));
    }
    const named = [
      ...new Set(
        (memory.entities ?? []).flatMap((name) => {
          const id = node(name, memory.id);
          return id ? [id] : [];
        }),
      ),
    ];
    if (named.length > MAX_MENTIONED_TOGETHER) continue;
    for (let i = 0; i < named.length; i += 1) {
      for (let j = i + 1; j < named.length; j += 1) {
        const pair = [named[i] as string, named[j] as string].sort() as [string, string];
        // A stated relation already says more than being mentioned together.
        if (!linked.has(JSON.stringify(pair))) edge(pair[0], pair[1], null, memory.id);
      }
    }
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => b.memories.length - a.memories.length),
    edges: [...edges.values()],
  };
}
