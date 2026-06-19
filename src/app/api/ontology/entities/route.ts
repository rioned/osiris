/**
 * ════════════════════════════════════════════════════════════════
 *  OSIRIS — Ontology Entities & Relationships API
 *  Full CRUD for personal ontology entities with graph operations.
 *
 *  Steps2 improvement: Durable entity storage replacing localStorage,
 *  with graph expansion, cross-referencing, and hybrid search.
 * ════════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Dynamic imports to avoid 'pg' module issues on client-side builds
let store: typeof import('@/lib/store/entity-store') | null = null;

async function getStore() {
  if (!store) {
    store = await import('@/lib/store/entity-store');
  }
  return store;
}

/**
 * GET /api/ontology/entities
 * List entities with optional filters.
 *
 * Query params:
 *   type      - Filter by entity type (e.g. 'person', 'phone_number')
 *   domain    - Filter by domain (e.g. 'PERSON', 'COMMUNICATION')
 *   search    - Full-text search across label, description, tags
 *   limit     - Max results (default: 100)
 *   offset    - Pagination offset
 *   graph     - If 'true', returns full graph (entities + relationships)
 *   expand    - If set to an entity ID, returns neighborhood graph
 */
export async function GET(req: NextRequest) {
  try {
    const s = await getStore();
    const { searchParams } = new URL(req.url);
    const graph = searchParams.get('graph');
    const expandId = searchParams.get('expand');
    const crossRef = searchParams.get('cross-reference');

    // Full graph query
    if (graph === 'true') {
      const result = await s.getGraph();
      return NextResponse.json(result);
    }

    // Entity expansion (neighborhood graph)
    if (expandId) {
      const depth = parseInt(searchParams.get('depth') || '1', 10);
      const result = await s.expandEntity(expandId, depth);
      return NextResponse.json(result);
    }

    // Cross-reference all entities
    if (crossRef === 'true') {
      const newRels = await s.runCrossReference();
      return NextResponse.json({ newRelationships: newRels, count: newRels.length });
    }

    // Standard filtered listing
    const result = await s.getEntities({
      type: searchParams.get('type') || undefined,
      domain: searchParams.get('domain') || undefined,
      search: searchParams.get('search') || undefined,
      limit: parseInt(searchParams.get('limit') || '100', 10),
      offset: parseInt(searchParams.get('offset') || '0', 10),
      nlpLanguage: searchParams.get('nlp_language') || undefined,
      nlpToxicityMin: searchParams.get('nlp_toxicity_min') ? parseFloat(searchParams.get('nlp_toxicity_min')!) : undefined,
      nlpEnriched: searchParams.get('nlp_enriched') === 'true' ? true : undefined,
      stanceTarget: searchParams.get('stance_target') || undefined,
      stanceSentiment: searchParams.get('stance_sentiment') || undefined,
      hasStance: searchParams.get('has_stance') === 'true' ? true : undefined,
    });

    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[OntologyEntities] GET error:', e.message);
    return NextResponse.json({ error: e.message, entities: [], total: 0 }, { status: 500 });
  }
}

/**
 * POST /api/ontology/entities
 * Create one or more entities and/or relationships.
 *
 * Body:
 *   { action: 'upsert', entity: {...} }       — Create/update single entity
 *   { action: 'batch', entities: [...] }       — Create/update multiple entities
 *   { action: 'relate', sourceId, targetId, label, strength } — Create relationship
 *   { action: 'cross-reference' }              — Run cross-ref rules
 */
export async function POST(req: NextRequest) {
  try {
    const s = await getStore();
    const body = await req.json();
    const action = body.action || 'upsert';

    switch (action) {
      case 'upsert': {
        const entity = await s.upsertEntity(body.entity || body);
        return NextResponse.json({ success: true, entity });
      }

      case 'batch': {
        const entities = body.entities || [];
        const results = [];
        for (const ent of entities) {
          results.push(await s.upsertEntity(ent));
        }
        return NextResponse.json({ success: true, entities: results, count: results.length });
      }

      case 'relate': {
        const rel = await s.createRelationship({
          sourceId: body.sourceId,
          targetId: body.targetId,
          label: body.label || 'related_to',
          strength: body.strength || 0.8,
          metadata: body.metadata || {},
        });
        return NextResponse.json({ success: true, relationship: rel });
      }

      case 'cross-reference': {
        const newRels = await s.runCrossReference();
        return NextResponse.json({ success: true, newRelationships: newRels, count: newRels.length });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[OntologyEntities] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * PUT /api/ontology/entities?id=xxx
 * Update a specific entity.
 */
export async function PUT(req: NextRequest) {
  try {
    const s = await getStore();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Missing id query param' }, { status: 400 });
    }

    const body = await req.json();
    const entity = await s.upsertEntity({ id, ...body });
    return NextResponse.json({ success: true, entity });
  } catch (e: any) {
    console.error('[OntologyEntities] PUT error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * DELETE /api/ontology/entities?id=xxx
 * Delete a specific entity (cascades to relationships).
 */
export async function DELETE(req: NextRequest) {
  try {
    const s = await getStore();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const relId = searchParams.get('relId');

    if (relId) {
      const deleted = await s.deleteRelationship(relId);
      return NextResponse.json({ success: deleted });
    }

    if (!id) {
      return NextResponse.json({ error: 'Missing id query param' }, { status: 400 });
    }

    const deleted = await s.deleteEntity(id);
    return NextResponse.json({ success: deleted });
  } catch (e: any) {
    console.error('[OntologyEntities] DELETE error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
