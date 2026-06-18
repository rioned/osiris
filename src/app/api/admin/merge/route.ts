/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Admin Identity Merge API
 *  Merge candidates review queue and merge/split actions.
 *
 *  GET  /api/admin/merge-candidates  → List all same_as pairs
 *  POST /api/admin/merge             → Merge two entities
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function getStore() {
  const store = await import('@/lib/store/entity-store');
  return store;
}

/**
 * GET /api/admin/merge-candidates
 * Returns all entities linked by 'same_as' relationships as merge candidates.
 * Admin-only: protected by middleware + token check.
 */
export async function GET(req: NextRequest) {
  try {
    const s = await getStore();
    const candidates = await s.findMergeCandidates();
    return NextResponse.json({ candidates, count: candidates.length });
  } catch (e: any) {
    console.error('[AdminMerge] GET error:', e.message);
    return NextResponse.json({ error: e.message, candidates: [], count: 0 }, { status: 500 });
  }
}

/**
 * POST /api/admin/merge
 * Merge two entities into one.
 * Body: { primaryId: string, duplicateId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const s = await getStore();
    const body = await req.json();
    const { primaryId, duplicateId } = body;

    if (!primaryId || !duplicateId) {
      return NextResponse.json(
        { error: 'Both primaryId and duplicateId are required' },
        { status: 400 }
      );
    }
    if (primaryId === duplicateId) {
      return NextResponse.json(
        { error: 'Cannot merge an entity with itself' },
        { status: 400 }
      );
    }

    const result = await s.mergeEntities(primaryId, duplicateId);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Merge failed — one or both entities not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      mergedEntity: result.mergedEntity,
    });
  } catch (e: any) {
    console.error('[AdminMerge] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/merge
 * Reject/dismiss a merge candidate by removing the same_as relationship.
 * Body: { relationshipId: string }
 */
export async function DELETE(req: NextRequest) {
  try {
    const s = await getStore();
    const body = await req.json();
    const { relationshipId } = body;

    if (!relationshipId) {
      return NextResponse.json({ error: 'relationshipId is required' }, { status: 400 });
    }

    const deleted = await s.deleteRelationship(relationshipId);
    return NextResponse.json({ success: deleted });
  } catch (e: any) {
    console.error('[AdminMerge] DELETE error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
