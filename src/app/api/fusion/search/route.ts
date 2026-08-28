/**
 * ════════════════════════════════════════════════════════════════
 *  OSIRIS — Data Fusion Search
 *  One query, fused across both halves of the ontology:
 *    • STRUCTURED  — entities matched by label/description/tags
 *    • UNSTRUCTURED — document chunks matched by full-text search
 *  Every hit comes back already wired to its graph neighbours, so a
 *  single search surfaces the entity, the document that mentions it,
 *  and everything else connected to either one.
 * ════════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let entityStore: typeof import('@/lib/store/entity-store') | null = null;
let docStore: typeof import('@/lib/store/document-store') | null = null;

async function getStores() {
  if (!entityStore) entityStore = await import('@/lib/store/entity-store');
  if (!docStore) docStore = await import('@/lib/store/document-store');
  return { entityStore, docStore };
}

const NEIGHBOR_CAP = 8;

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get('q') || '').trim();
    const limit = Math.min(parseInt(searchParams.get('limit') || '15', 10) || 15, 50);

    if (!q) {
      return NextResponse.json({ query: q, entities: [], documents: [], tookMs: Date.now() - t0 });
    }

    const { entityStore: es, docStore: ds } = await getStores();

    const [{ entities: structuredHits }, chunkHits] = await Promise.all([
      es.getEntities({ search: q, limit }),
      ds.searchChunks(q, limit),
    ]);

    // Structured hits — attach 1-hop neighbours so the search result already
    // shows "this entity, connected to X, Y, Z" rather than a bare record.
    const entities = await Promise.all(structuredHits.map(async (e) => {
      const rels = await es.getRelationships({ entityId: e.id });
      const neighbors = await Promise.all(
        rels.slice(0, NEIGHBOR_CAP).map(async (r) => {
          const otherId = r.sourceId === e.id ? r.targetId : r.sourceId;
          const other = await es.getEntity(otherId);
          return other ? { id: other.id, label: other.label, type: other.type, relation: r.label, strength: r.strength } : null;
        })
      );
      return {
        id: e.id, type: e.type, domain: e.domain, label: e.label, description: e.description,
        coordinates: e.coordinates, tags: e.tags, source: e.source,
        neighbors: neighbors.filter(Boolean),
        relationCount: rels.length,
      };
    }));

    // Unstructured hits — resolve the document's own graph node and who mentions it.
    const documents = await Promise.all(chunkHits.map(async (c) => {
      const docEntity = await es.getEntity(c.docEntityId);
      const rels = await es.getRelationships({ entityId: c.docEntityId });
      const linkedEntities = await Promise.all(
        rels.filter(r => r.label === 'mentioned_in').slice(0, NEIGHBOR_CAP).map(async (r) => {
          const ent = await es.getEntity(r.sourceId);
          return ent ? { id: ent.id, label: ent.label, type: ent.type, strength: r.strength } : null;
        })
      );
      return {
        sourceId: c.sourceId, docEntityId: c.docEntityId, chunkId: c.chunkId,
        title: c.title, uri: c.uri, kind: c.kind, snippet: c.snippet, rank: c.rank,
        properties: docEntity?.properties,
        linkedEntities: linkedEntities.filter(Boolean),
      };
    }));

    return NextResponse.json({ query: q, entities, documents, tookMs: Date.now() - t0 });
  } catch (e: any) {
    console.error('[FusionSearch] error:', e.message);
    return NextResponse.json({ error: e.message, entities: [], documents: [] }, { status: 500 });
  }
}
