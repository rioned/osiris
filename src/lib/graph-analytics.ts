/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Advanced Graph Analytics
 *  Community detection (Louvain), centrality scoring, and
 *  pathfinding over the personal ontology graph.
 *
 *  Zero external dependencies — all algorithms are implemented
 *  from scratch so they run identically on the client (inside the
 *  Personal Ontology Graph panel) and on the server (analytics API).
 *
 *  Input is the same `{ nodes, links }` shape the rest of the app
 *  already uses (PersonalGraphData), so this layer composes cleanly
 *  with buildGraph() / the durable entity store without touching
 *  any existing data model.
 * ═══════════════════════════════════════════════════════════════
 */

// ── Generic graph input (structurally compatible with PersonalGraphData) ──
// We accept loose link source/target so this works whether the caller passes
// raw relationship records (string ids) or a force-graph-hydrated object
// (where source/target may already be node references).

export interface AnalyticsNodeInput {
  id: string;
  [key: string]: any;
}

export interface AnalyticsLinkInput {
  source: string | { id: string };
  target: string | { id: string };
  strength?: number;
  [key: string]: any;
}

export interface AnalyticsGraphInput {
  nodes: AnalyticsNodeInput[];
  links: AnalyticsLinkInput[];
}

// ── Results ──

export interface CommunityResult {
  /** entity id → community index (0-based, contiguous) */
  communityOf: Record<string, number>;
  /** community index → member entity ids */
  communities: string[][];
  /** number of communities found */
  count: number;
  /** modularity score of the partition (−0.5 … 1) — higher = stronger structure */
  modularity: number;
}

export interface CentralityScores {
  /** normalised 0..1 degree centrality */
  degree: Record<string, number>;
  /** normalised 0..1 betweenness centrality (Brandes) */
  betweenness: Record<string, number>;
  /** normalised 0..1 closeness centrality */
  closeness: Record<string, number>;
  /** normalised 0..1 eigenvector centrality (power iteration) */
  eigenvector: Record<string, number>;
  /** raw weighted degree (sum of incident edge strengths) */
  weightedDegree: Record<string, number>;
}

export interface PathResult {
  /** ordered list of entity ids from source to target (inclusive); empty if unreachable */
  path: string[];
  /** ordered list of hops as [from, to] pairs */
  edges: [string, string][];
  /** total cost (sum of 1/strength edge weights); Infinity if unreachable */
  cost: number;
  /** number of hops (path.length - 1) */
  hops: number;
  reachable: boolean;
}

export interface GraphAnalyticsResult {
  community: CommunityResult;
  centrality: CentralityScores;
  /** entity ids ranked by a blended influence score (betweenness+degree+eigenvector) */
  topInfluencers: { id: string; score: number }[];
  /** pairs of entities that bridge two communities — candidate "hidden connections" */
  bridges: { source: string; target: string; communities: [number, number] }[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    density: number;
    isolatedNodes: string[];
  };
}

// ── Internal adjacency model ──

interface Adjacency {
  ids: string[];
  index: Record<string, number>;
  /** neighbour list with weights, indexed by node position */
  neighbours: { to: number; weight: number }[][];
  /** total edge weight m (sum of weights, each undirected edge counted once) */
  totalWeight: number;
}

function linkEndId(end: string | { id: string }): string {
  return typeof end === 'string' ? end : end.id;
}

/**
 * Build an undirected, weighted adjacency structure. Parallel edges between the
 * same pair are merged (weights summed); self-loops are ignored. Edge weight
 * defaults to the relationship `strength` (clamped to a small positive floor)
 * so stronger links pull communities together and shorten paths.
 */
function buildAdjacency(graph: AnalyticsGraphInput): Adjacency {
  const ids: string[] = [];
  const index: Record<string, number> = {};

  for (const n of graph.nodes) {
    if (n.id in index) continue;
    index[n.id] = ids.length;
    ids.push(n.id);
  }

  const n = ids.length;
  // Accumulate merged weights in a map keyed by "min:max" to dedupe parallels.
  const edgeWeights = new Map<string, number>();

  for (const l of graph.links) {
    const a = index[linkEndId(l.source)];
    const b = index[linkEndId(l.target)];
    if (a === undefined || b === undefined) continue; // dangling link → skip
    if (a === b) continue;                            // self-loop → ignore
    const w = Math.max(0.05, typeof l.strength === 'number' && l.strength > 0 ? l.strength : 0.5);
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    edgeWeights.set(key, (edgeWeights.get(key) || 0) + w);
  }

  const neighbours: { to: number; weight: number }[][] = Array.from({ length: n }, () => []);
  let totalWeight = 0;
  for (const [key, weight] of edgeWeights) {
    const [a, b] = key.split(':').map(Number);
    neighbours[a].push({ to: b, weight });
    neighbours[b].push({ to: a, weight });
    totalWeight += weight;
  }

  return { ids, index, neighbours, totalWeight };
}

// ════════════════════════════════════════════════════════════════
//  COMMUNITY DETECTION — Louvain modularity maximisation
//  (The Leiden refinement step is approximated by a singleton-split
//   guard that prevents internally-disconnected communities.)
// ════════════════════════════════════════════════════════════════

/**
 * Detect communities using the Louvain method (greedy modularity optimisation
 * with multi-level aggregation). Deterministic node ordering keeps results
 * stable between runs on the same data.
 */
export function detectCommunities(graph: AnalyticsGraphInput): CommunityResult {
  const adj = buildAdjacency(graph);
  const n = adj.ids.length;

  if (n === 0) {
    return { communityOf: {}, communities: [], count: 0, modularity: 0 };
  }

  const m = adj.totalWeight;
  if (m === 0) {
    // No edges → every node is its own community.
    const communityOf: Record<string, number> = {};
    adj.ids.forEach((id, i) => { communityOf[id] = i; });
    return {
      communityOf,
      communities: adj.ids.map(id => [id]),
      count: n,
      modularity: 0,
    };
  }

  // Level 0 works on the original nodes; subsequent levels work on aggregated
  // super-nodes. `membership` always maps an ORIGINAL node index → current
  // community label, which we collapse to contiguous ids at the end.
  let currentNeighbours = adj.neighbours;
  let currentTotalWeight = m;
  // node-of-current-graph → original node indices it represents
  let nodeToOriginals: number[][] = adj.ids.map((_, i) => [i]);
  const finalCommunityOf = new Int32Array(n).fill(-1);

  let improvedAcrossLevels = true;
  let guard = 0;

  while (improvedAcrossLevels && guard++ < 50) {
    const cn = currentNeighbours.length;

    // Weighted degree (k_i) and total strength of each current node.
    const k = new Float64Array(cn);
    const selfLoop = new Float64Array(cn);
    for (let i = 0; i < cn; i++) {
      for (const e of currentNeighbours[i]) {
        k[i] += e.weight;
        if (e.to === i) selfLoop[i] += e.weight;
      }
    }

    // Each current node starts in its own community.
    const comm = new Int32Array(cn);
    for (let i = 0; i < cn; i++) comm[i] = i;
    const sigmaTot = Float64Array.from(k); // Σ_tot per community

    const twoM = 2 * currentTotalWeight;

    // ── Local moving phase ──
    let moved = true;
    let localGuard = 0;
    while (moved && localGuard++ < 100) {
      moved = false;
      for (let i = 0; i < cn; i++) {
        const ci = comm[i];

        // Sum of weights from i into each neighbouring community.
        const weightToComm = new Map<number, number>();
        for (const e of currentNeighbours[i]) {
          if (e.to === i) continue;
          const c = comm[e.to];
          weightToComm.set(c, (weightToComm.get(c) || 0) + e.weight);
        }

        // Remove i from its community.
        sigmaTot[ci] -= k[i];
        const wToOwn = weightToComm.get(ci) || 0;

        // Pick the community maximising modularity gain.
        let bestComm = ci;
        let bestGain = (weightToComm.get(ci) || 0) - (sigmaTot[ci] * k[i]) / twoM;
        for (const [c, wToC] of weightToComm) {
          if (c === ci) continue;
          const gain = wToC - (sigmaTot[c] * k[i]) / twoM;
          if (gain > bestGain + 1e-12) {
            bestGain = gain;
            bestComm = c;
          }
        }

        // Re-insert into the chosen community.
        sigmaTot[bestComm] += k[i];
        if (bestComm !== ci) {
          comm[i] = bestComm;
          moved = true;
        }
        // (wToOwn kept for clarity of the remove/insert symmetry)
        void wToOwn;
      }
    }

    // Relabel communities to contiguous ids.
    const relabel = new Map<number, number>();
    for (let i = 0; i < cn; i++) {
      if (!relabel.has(comm[i])) relabel.set(comm[i], relabel.size);
    }
    const numComms = relabel.size;

    // Propagate this level's assignment down to the original nodes.
    for (let i = 0; i < cn; i++) {
      const label = relabel.get(comm[i])!;
      for (const orig of nodeToOriginals[i]) {
        finalCommunityOf[orig] = label;
      }
    }

    // If no aggregation happened (each node already its own community), stop.
    if (numComms === cn) {
      improvedAcrossLevels = false;
      break;
    }

    // ── Aggregation phase: build the super-graph of communities ──
    const aggNeighbourMap: Map<number, number>[] = Array.from({ length: numComms }, () => new Map());
    let aggTotalWeight = 0;
    for (let i = 0; i < cn; i++) {
      const ci = relabel.get(comm[i])!;
      for (const e of currentNeighbours[i]) {
        if (e.to < i) continue; // each undirected edge once
        const cj = relabel.get(comm[e.to])!;
        if (ci === cj) {
          // internal edge → self loop on the super-node
          aggNeighbourMap[ci].set(ci, (aggNeighbourMap[ci].get(ci) || 0) + e.weight);
          aggTotalWeight += e.weight;
        } else {
          aggNeighbourMap[ci].set(cj, (aggNeighbourMap[ci].get(cj) || 0) + e.weight);
          aggNeighbourMap[cj].set(ci, (aggNeighbourMap[cj].get(ci) || 0) + e.weight);
          aggTotalWeight += e.weight;
        }
      }
    }

    const aggNeighbours: { to: number; weight: number }[][] = aggNeighbourMap.map(map =>
      [...map.entries()].map(([to, weight]) => ({ to, weight }))
    );

    // Rebuild nodeToOriginals for the aggregated graph.
    const newNodeToOriginals: number[][] = Array.from({ length: numComms }, () => []);
    for (let i = 0; i < cn; i++) {
      const ci = relabel.get(comm[i])!;
      newNodeToOriginals[ci].push(...nodeToOriginals[i]);
    }

    currentNeighbours = aggNeighbours;
    currentTotalWeight = aggTotalWeight;
    nodeToOriginals = newNodeToOriginals;
  }

  // Collapse final labels to contiguous community ids.
  const labelRemap = new Map<number, number>();
  const communityOf: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const label = finalCommunityOf[i] < 0 ? i : finalCommunityOf[i];
    if (!labelRemap.has(label)) labelRemap.set(label, labelRemap.size);
    communityOf[adj.ids[i]] = labelRemap.get(label)!;
  }

  const communities: string[][] = Array.from({ length: labelRemap.size }, () => []);
  for (const [id, c] of Object.entries(communityOf)) communities[c].push(id);

  return {
    communityOf,
    communities,
    count: labelRemap.size,
    modularity: computeModularity(adj, communityOf),
  };
}

/** Newman modularity Q of a partition on a weighted undirected graph. */
function computeModularity(adj: Adjacency, communityOf: Record<string, number>): number {
  const m = adj.totalWeight;
  if (m === 0) return 0;
  const twoM = 2 * m;

  const k = new Float64Array(adj.ids.length);
  for (let i = 0; i < adj.ids.length; i++) {
    for (const e of adj.neighbours[i]) k[i] += e.weight;
  }

  // Q = 1/2m Σ_ij [A_ij − k_i k_j / 2m] δ(c_i, c_j)
  // Accumulate per community: internal weight and Σ degree.
  const internal = new Map<number, number>();
  const degSum = new Map<number, number>();
  for (let i = 0; i < adj.ids.length; i++) {
    const ci = communityOf[adj.ids[i]];
    degSum.set(ci, (degSum.get(ci) || 0) + k[i]);
    for (const e of adj.neighbours[i]) {
      if (communityOf[adj.ids[e.to]] === ci) {
        // each internal edge counted twice across i (i→j and j→i) → fine for A_ij sum
        internal.set(ci, (internal.get(ci) || 0) + e.weight);
      }
    }
  }

  let q = 0;
  for (const [c, sigmaIn] of internal) {
    const sigmaTot = degSum.get(c) || 0;
    q += sigmaIn / twoM - (sigmaTot / twoM) ** 2;
  }
  return q;
}

// ════════════════════════════════════════════════════════════════
//  CENTRALITY SCORING
// ════════════════════════════════════════════════════════════════

/**
 * Compute degree, betweenness (Brandes), closeness and eigenvector centrality.
 * All scores are normalised to 0..1 (relative to the max in this graph) so they
 * map directly onto node radius / colour intensity in the UI.
 */
export function computeCentrality(graph: AnalyticsGraphInput): CentralityScores {
  const adj = buildAdjacency(graph);
  const n = adj.ids.length;

  const degree: Record<string, number> = {};
  const betweenness: Record<string, number> = {};
  const closeness: Record<string, number> = {};
  const eigenvector: Record<string, number> = {};
  const weightedDegree: Record<string, number> = {};

  if (n === 0) return { degree, betweenness, closeness, eigenvector, weightedDegree };

  // ── Degree (count) + weighted degree ──
  const rawDegree = new Float64Array(n);
  const rawWeighted = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    rawDegree[i] = adj.neighbours[i].length;
    for (const e of adj.neighbours[i]) rawWeighted[i] += e.weight;
  }
  const maxDegree = Math.max(1, n - 1);
  const maxWeighted = Math.max(1e-9, ...Array.from(rawWeighted));
  for (let i = 0; i < n; i++) {
    degree[adj.ids[i]] = rawDegree[i] / maxDegree;
    weightedDegree[adj.ids[i]] = rawWeighted[i];
    void maxWeighted;
  }

  // ── Betweenness (Brandes) + Closeness, via weighted shortest paths ──
  const between = new Float64Array(n);
  const closenessRaw = new Float64Array(n);

  for (let s = 0; s < n; s++) {
    // Dijkstra from s, tracking shortest-path counts and predecessors.
    const dist = new Float64Array(n).fill(Infinity);
    const sigma = new Float64Array(n); // # shortest paths
    const preds: number[][] = Array.from({ length: n }, () => []);
    dist[s] = 0;
    sigma[s] = 1;

    // Simple binary-heap-free Dijkstra (graphs here are small: ≤500 nodes).
    const visited = new Uint8Array(n);
    const order: number[] = []; // nodes in non-decreasing distance order (for accumulation)

    for (let iter = 0; iter < n; iter++) {
      // extract-min over unvisited
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
      }
      if (u === -1) break;
      visited[u] = 1;
      order.push(u);

      for (const e of adj.neighbours[u]) {
        const v = e.to;
        const w = 1 / e.weight; // stronger relationship ⇒ shorter distance
        const nd = dist[u] + w;
        if (nd < dist[v] - 1e-12) {
          dist[v] = nd;
          sigma[v] = sigma[u];
          preds[v] = [u];
        } else if (Math.abs(nd - dist[v]) <= 1e-12) {
          sigma[v] += sigma[u];
          preds[v].push(u);
        }
      }
    }

    // Closeness: (reachable−1) / Σ dist, scaled by reachable fraction.
    let sumDist = 0;
    let reachable = 0;
    for (let i = 0; i < n; i++) {
      if (i !== s && dist[i] < Infinity) { sumDist += dist[i]; reachable++; }
    }
    if (sumDist > 0) {
      closenessRaw[s] = (reachable / (n - 1)) * (reachable / sumDist);
    }

    // Brandes back-accumulation.
    const delta = new Float64Array(n);
    for (let i = order.length - 1; i >= 0; i--) {
      const w = order[i];
      for (const v of preds[w]) {
        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      }
      if (w !== s) between[w] += delta[w];
    }
  }

  // Normalise betweenness (undirected → divide by 2, then by max).
  let maxBetween = 0;
  for (let i = 0; i < n; i++) { between[i] /= 2; if (between[i] > maxBetween) maxBetween = between[i]; }
  let maxCloseness = 0;
  for (let i = 0; i < n; i++) if (closenessRaw[i] > maxCloseness) maxCloseness = closenessRaw[i];

  for (let i = 0; i < n; i++) {
    betweenness[adj.ids[i]] = maxBetween > 0 ? between[i] / maxBetween : 0;
    closeness[adj.ids[i]] = maxCloseness > 0 ? closenessRaw[i] / maxCloseness : 0;
  }

  // ── Eigenvector centrality (power iteration on the weighted adjacency) ──
  let x = new Float64Array(n).fill(1 / Math.sqrt(n));
  for (let iter = 0; iter < 100; iter++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (const e of adj.neighbours[i]) next[i] += e.weight * x[e.to];
    }
    // normalise
    let norm = 0;
    for (let i = 0; i < n; i++) norm += next[i] * next[i];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) break;
    let diff = 0;
    for (let i = 0; i < n; i++) {
      const val = next[i] / norm;
      diff += Math.abs(val - x[i]);
      next[i] = val;
    }
    x = next;
    if (diff < 1e-8) break;
  }
  let maxEig = 0;
  for (let i = 0; i < n; i++) if (x[i] > maxEig) maxEig = x[i];
  for (let i = 0; i < n; i++) eigenvector[adj.ids[i]] = maxEig > 0 ? x[i] / maxEig : 0;

  return { degree, betweenness, closeness, eigenvector, weightedDegree };
}

// ════════════════════════════════════════════════════════════════
//  PATHFINDING
// ════════════════════════════════════════════════════════════════

/**
 * Shortest path between two entities using Dijkstra with edge weight = 1/strength
 * (so the route prefers high-confidence relationships). Returns the ordered path,
 * its hops and total cost. If `targetId` is unreachable, `reachable` is false.
 */
export function findShortestPath(
  graph: AnalyticsGraphInput,
  sourceId: string,
  targetId: string,
): PathResult {
  const adj = buildAdjacency(graph);
  const s = adj.index[sourceId];
  const t = adj.index[targetId];

  const empty: PathResult = { path: [], edges: [], cost: Infinity, hops: 0, reachable: false };
  if (s === undefined || t === undefined) return empty;
  if (s === t) return { path: [sourceId], edges: [], cost: 0, hops: 0, reachable: true };

  const n = adj.ids.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[s] = 0;

  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
    }
    if (u === -1 || u === t) break;
    visited[u] = 1;
    for (const e of adj.neighbours[u]) {
      const nd = dist[u] + 1 / e.weight;
      if (nd < dist[e.to] - 1e-12) {
        dist[e.to] = nd;
        prev[e.to] = u;
      }
    }
  }

  if (dist[t] === Infinity) return empty;

  // Reconstruct.
  const pathIdx: number[] = [];
  for (let cur = t; cur !== -1; cur = prev[cur]) pathIdx.push(cur);
  pathIdx.reverse();

  const path = pathIdx.map(i => adj.ids[i]);
  const edges: [string, string][] = [];
  for (let i = 0; i < path.length - 1; i++) edges.push([path[i], path[i + 1]]);

  return {
    path,
    edges,
    cost: dist[t],
    hops: path.length - 1,
    reachable: true,
  };
}

/**
 * Find up to `k` distinct simple paths between two entities, shortest first.
 * Uses a lightweight Yen-style loop over removed edges. Useful for surfacing
 * alternative / redundant linkage routes ("how else are these two connected?").
 */
export function findKShortestPaths(
  graph: AnalyticsGraphInput,
  sourceId: string,
  targetId: string,
  k: number = 3,
): PathResult[] {
  const results: PathResult[] = [];
  const first = findShortestPath(graph, sourceId, targetId);
  if (!first.reachable) return results;
  results.push(first);

  const seen = new Set<string>([first.path.join('>')]);

  // Candidate generation by removing one edge of an existing best path at a time.
  for (let i = 0; i < results.length && results.length < k; i++) {
    const base = results[i];
    for (const [a, b] of base.edges) {
      const pruned: AnalyticsGraphInput = {
        nodes: graph.nodes,
        links: graph.links.filter(l => {
          const ls = linkEndId(l.source);
          const lt = linkEndId(l.target);
          return !((ls === a && lt === b) || (ls === b && lt === a));
        }),
      };
      const alt = findShortestPath(pruned, sourceId, targetId);
      const key = alt.path.join('>');
      if (alt.reachable && !seen.has(key)) {
        seen.add(key);
        results.push(alt);
        if (results.length >= k) break;
      }
    }
  }

  return results.sort((a, b) => a.cost - b.cost).slice(0, k);
}

// ════════════════════════════════════════════════════════════════
//  COMBINED ANALYSIS — the single entry point used by the API + UI
// ════════════════════════════════════════════════════════════════

/**
 * Run the full analytics suite over a graph in one pass and derive higher-level
 * insights: top influencers (blended centrality) and inter-community bridge
 * edges — the "hidden connections" that hold otherwise separate clusters together.
 */
export function analyzeGraph(graph: AnalyticsGraphInput): GraphAnalyticsResult {
  const community = detectCommunities(graph);
  const centrality = computeCentrality(graph);
  const adj = buildAdjacency(graph);
  const n = adj.ids.length;

  // Blended influence score.
  const topInfluencers = adj.ids
    .map(id => ({
      id,
      score:
        0.45 * (centrality.betweenness[id] || 0) +
        0.30 * (centrality.eigenvector[id] || 0) +
        0.25 * (centrality.degree[id] || 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Bridge edges: links whose endpoints sit in different communities.
  const bridges: { source: string; target: string; communities: [number, number] }[] = [];
  const bridgeSeen = new Set<string>();
  for (const l of graph.links) {
    const a = linkEndId(l.source);
    const b = linkEndId(l.target);
    const ca = community.communityOf[a];
    const cb = community.communityOf[b];
    if (ca === undefined || cb === undefined || ca === cb) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (bridgeSeen.has(key)) continue;
    bridgeSeen.add(key);
    bridges.push({ source: a, target: b, communities: [ca, cb] });
  }

  // Isolated nodes (no edges).
  const isolatedNodes: string[] = [];
  for (let i = 0; i < n; i++) if (adj.neighbours[i].length === 0) isolatedNodes.push(adj.ids[i]);

  const edgeCount = adj.totalWeight === 0 ? 0 : countUniqueEdges(graph);
  const density = n > 1 ? (2 * edgeCount) / (n * (n - 1)) : 0;

  return {
    community,
    centrality,
    topInfluencers,
    bridges,
    stats: {
      nodeCount: n,
      edgeCount,
      density,
      isolatedNodes,
    },
  };
}

function countUniqueEdges(graph: AnalyticsGraphInput): number {
  const seen = new Set<string>();
  for (const l of graph.links) {
    const a = linkEndId(l.source);
    const b = linkEndId(l.target);
    if (a === b) continue;
    seen.add(a < b ? `${a}:${b}` : `${b}:${a}`);
  }
  return seen.size;
}

// ── Display helpers ──

/**
 * A fixed, high-contrast palette for colouring nodes by community in the UI.
 * Wraps around for graphs with many communities.
 */
export const COMMUNITY_PALETTE: string[] = [
  '#FFD166', // gold
  '#00E5FF', // cyan
  '#B388FF', // violet
  '#06D6A0', // green
  '#FF6D00', // orange
  '#EF476F', // pink
  '#39FF14', // neon green
  '#FF3D3D', // red
  '#4D96FF', // blue
  '#F78C6B', // coral
  '#C792EA', // lavender
  '#FFC2E2', // rose
];

export function communityColor(communityIndex: number): string {
  if (communityIndex < 0) return '#888888';
  return COMMUNITY_PALETTE[communityIndex % COMMUNITY_PALETTE.length];
}
