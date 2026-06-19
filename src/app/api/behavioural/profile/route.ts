/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Behavioural & Temporal Profiling API
 *
 *  POST /api/behavioural/profile
 *    Build a behavioural profile for an entity.
 *    Body: { entityId: string }
 *
 *  POST /api/behavioural/compare
 *    Compare two entities for coordinated activity.
 *    Body: { entityIds: string[] }
 *
 *  GET /api/behavioural/profile?entityId=xxx
 *    Quick profile lookup.
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildProfile, detectCoordinatedActivity } from '@/lib/behavioural/profiling';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || 'profile';

    switch (action) {
      case 'profile': {
        const entityId = body.entityId;
        if (!entityId) {
          return NextResponse.json({ error: 'No entityId provided' }, { status: 400 });
        }

        const profile = await buildProfile(entityId);
        if (!profile) {
          return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
        }

        return NextResponse.json({
          success: true,
          profile,
        });
      }

      case 'compare': {
        const entityIds: string[] = body.entityIds || [];
        if (entityIds.length < 2) {
          return NextResponse.json({ error: 'At least 2 entityIds required' }, { status: 400 });
        }

        const clusters = await detectCoordinatedActivity(entityIds);
        return NextResponse.json({
          success: true,
          clusters,
          count: clusters.length,
        });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[Behavioural] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const entityId = searchParams.get('entityId');
    const compareIds = searchParams.get('compare');

    if (!entityId) {
      return NextResponse.json({
        name: 'OSIRIS Behavioural Profiling',
        usage: {
          profile: 'GET /api/behavioural/profile?entityId=xxx',
          list: 'GET /api/behavioural/profiles?limit=10',
        },
        description: 'Per-entity timelines, activity baselines, anomaly detection, and sock-puppet clustering',
      });
    }

    const profile = await buildProfile(entityId);
    if (!profile) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      profile,
    });
  } catch (e: any) {
    console.error('[Behavioural] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
