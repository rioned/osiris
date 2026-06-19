/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Influence & Narrative Analytics API
 *
 *  GET /api/influence/analysis
 *    Full influence analysis: opinion communities, top influencers,
 *    bridge accounts, narrative traces.
 *
 *  GET /api/influence/influencers?topic=rwanda
 *    Get ranked influencers for a specific stance target.
 *
 *  GET /api/influence/bridges
 *    Get all bridge accounts.
 *
 *  GET /api/influence/trace?topic=rwanda&originatorId=xxx
 *    Trace a narrative from its origin.
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  runInfluenceAnalysis,
  getInfluencersForTopic,
  getBridgeAccounts,
  traceNarrativeFromOrigin,
} from '@/lib/influence/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('mode') || 'analysis';
    const topic = searchParams.get('topic');
    const originatorId = searchParams.get('originatorId');

    switch (mode) {
      case 'analysis': {
        const result = await runInfluenceAnalysis();
        return NextResponse.json({
          success: true,
          ...result,
        });
      }

      case 'influencers': {
        if (!topic) {
          return NextResponse.json({ error: 'topic query param required' }, { status: 400 });
        }
        const influencers = await getInfluencersForTopic(topic);
        return NextResponse.json({
          success: true,
          topic,
          count: influencers.length,
          influencers: influencers.slice(0, 20),
        });
      }

      case 'bridges': {
        const bridges = await getBridgeAccounts();
        return NextResponse.json({
          success: true,
          count: bridges.length,
          bridges: bridges.slice(0, 30),
        });
      }

      case 'trace': {
        if (!topic || !originatorId) {
          return NextResponse.json({ error: 'topic and originatorId query params required' }, { status: 400 });
        }
        const trace = await traceNarrativeFromOrigin(topic, originatorId);
        return NextResponse.json({
          success: true,
          trace,
        });
      }

      default:
        return NextResponse.json({
          name: 'OSIRIS Influence & Narrative Analytics',
          modes: {
            analysis: 'GET /api/influence/analysis',
            influencers: 'GET /api/influence/analysis?mode=influencers&topic=rwanda',
            bridges: 'GET /api/influence/analysis?mode=bridges',
            trace: 'GET /api/influence/analysis?mode=trace&topic=rwanda&originatorId=xxx',
          },
        });
    }
  } catch (e: any) {
    console.error('[Influence] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || 'analysis';

    switch (action) {
      case 'analysis': {
        const result = await runInfluenceAnalysis();
        return NextResponse.json({ success: true, ...result });
      }

      case 'influencers': {
        const topic = body.topic;
        if (!topic) return NextResponse.json({ error: 'topic required' }, { status: 400 });
        const influencers = await getInfluencersForTopic(topic);
        return NextResponse.json({ success: true, topic, count: influencers.length, influencers });
      }

      case 'trace': {
        const { topic, originatorId } = body;
        if (!topic || !originatorId) {
          return NextResponse.json({ error: 'topic and originatorId required' }, { status: 400 });
        }
        const trace = await traceNarrativeFromOrigin(topic, originatorId);
        return NextResponse.json({ success: true, trace });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[Influence] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
