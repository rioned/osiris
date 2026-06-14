/**
 * ════════════════════════════════════════════════════════════════
 *  OSIRIS — Ontology Graph Analytics API
 *  Advanced graph analytics over the durable ontology store:
 *    • Community detection (Louvain / Leiden-style modularity)
 *    • Centrality scoring (degree, betweenness, closeness, eigenvector)
 *    • Pathfinding between entities (shortest + k-shortest)
 *
 *  Mirrors the conventions of /api/ontology/entities — dynamic store
 *  import to keep 'pg' off the client bundle, graceful 500s, and the
 *  same `{ entities, relationships }` graph shape it already serves.
 * ════════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  analyzeGraph,
  detectCommunities,
  computeCentrality,
  findShortestPath,
  findKShortestPaths,
  type AnalyticsGraphInput,
} from '@/lib/graph-analytics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Dynamic import to avoid 'pg' module issues on client-side builds (same as entities route).
let store: typeof import('@/lib/store/entity-store') | null = null;
async function getStore() {
  if (!store) store = await import('@/lib/store/entity-store');
  return store;
}

/** Build the analytics graph input from the durable store's relationship graph. */
async function loadGraph(): Promise<AnalyticsGraphInput> {
  const s = await getStore();
  const { entities, relationships } = await s.getGraph();
  return {
    nodes: entities.map(e => ({ id: e.id, label: e.label, type: e.type, domain: e.domain })),
    links: relationships.map(r => ({ source: r.sourceId, target: r.targetId, strength: r.strength })),
  };
}

/**
 * GET /api/ontology/analytics
 *
 * Query params:
 *   metric=full         (default) — communities + centrality + insights
 *   metric=community    — Louvain community partition only
 *   metric=centrality   — centrality scores only
 *   metric=path&from=ID&to=ID[&k=N] — shortest (or k-shortest) path between two entities
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const metric = searchParams.get('metric') || 'full';

    if (metric === 'path') {
      const from = searchParams.get('from');
      const to = searchParams.get('to');
      if (!from || !to) {
        return NextResponse.json({ error: 'path metric requires "from" and "to" query params' }, { status: 400 });
      }
      const graph = await loadGraph();
      const k = parseInt(searchParams.get('k') || '1', 10);
      if (k > 1) {
        const paths = findKShortestPaths(graph, from, to, Math.min(k, 5));
        return NextResponse.json({ from, to, paths, count: paths.length });
      }
      const path = findShortestPath(graph, from, to);
      return NextResponse.json({ from, to, ...path });
    }

    const graph = await loadGraph();

    if (metric === 'community') {
      return NextResponse.json(detectCommunities(graph));
    }
    if (metric === 'centrality') {
      return NextResponse.json(computeCentrality(graph));
    }

    // Full suite.
    return NextResponse.json(analyzeGraph(graph));
  } catch (e: any) {
    console.error('[OntologyAnalytics] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/ontology/analytics
 * Run analytics against a client-supplied graph (e.g. the in-browser personal
 * store that is not persisted server-side). Lets the panel analyse local data
 * without first round-tripping every entity to the database.
 *
 * Body:
 *   { action: 'analyze', graph: { nodes, links } }
 *   { action: 'community', graph }
 *   { action: 'centrality', graph }
 *   { action: 'path', graph, from, to, k? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || 'analyze';
    const graph: AnalyticsGraphInput = body.graph || { nodes: [], links: [] };

    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
      return NextResponse.json({ error: 'graph.nodes and graph.links must be arrays' }, { status: 400 });
    }

    switch (action) {
      case 'analyze':
        return NextResponse.json(analyzeGraph(graph));
      case 'community':
        return NextResponse.json(detectCommunities(graph));
      case 'centrality':
        return NextResponse.json(computeCentrality(graph));
      case 'path': {
        if (!body.from || !body.to) {
          return NextResponse.json({ error: 'path action requires "from" and "to"' }, { status: 400 });
        }
        const k = parseInt(String(body.k || 1), 10);
        if (k > 1) {
          const paths = findKShortestPaths(graph, body.from, body.to, Math.min(k, 5));
          return NextResponse.json({ from: body.from, to: body.to, paths, count: paths.length });
        }
        return NextResponse.json({ from: body.from, to: body.to, ...findShortestPath(graph, body.from, body.to) });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[OntologyAnalytics] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
