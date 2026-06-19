/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — AI Integration API
 *
 *  POST /api/ai/integrate
 *    action=resolve-identity  — AI-powered entity matching
 *    action=parse-feed        — AI-powered connector parsing
 *    action=graph-insights    — AI-powered graph analytics
 *    action=graph-narrative   — AI-generated graph narrative
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { aiIntegration } from '@/lib/ai-integration';
import { getEntity } from '@/lib/store/entity-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || '';

    switch (action) {
      // ── 1. AI Identity Resolution ──
      case 'resolve-identity': {
        const { entityIdA, entityIdB } = body;
        if (!entityIdA || !entityIdB) {
          return NextResponse.json({ error: 'entityIdA and entityIdB required' }, { status: 400 });
        }

        const [entityA, entityB] = await Promise.all([
          getEntity(entityIdA),
          getEntity(entityIdB),
        ]);

        if (!entityA || !entityB) {
          return NextResponse.json({ error: 'One or both entities not found' }, { status: 404 });
        }

        const result = await aiIntegration.resolveIdentity(entityA, entityB);
        if (!result) {
          return NextResponse.json({ error: 'AI resolution unavailable' }, { status: 503 });
        }

        const isMatch = result.score > 0.6;
        return NextResponse.json({
          success: true,
          entityA: { id: entityA.id, label: entityA.label, type: entityA.type },
          entityB: { id: entityB.id, label: entityB.label, type: entityB.type },
          aiScore: result.score,
          isMatch,
          reason: result.reason,
          signals: result.signals,
          recommendation: isMatch
            ? `AI recommends MERGE (confidence ${Math.round(result.score * 100)}%)`
            : `AI recommends KEEP SEPARATE (confidence ${Math.round((1 - result.score) * 100)}%)`,
        });
      }

      // ── 2. AI Connector Feed Parsing ──
      case 'parse-feed': {
        const { rawData, source, fileType } = body;
        if (!rawData) {
          return NextResponse.json({ error: 'rawData required' }, { status: 400 });
        }

        const result = await aiIntegration.parseFeed(rawData, source || 'unknown', fileType || 'text');

        return NextResponse.json({
          success: true,
          source: source || 'unknown',
          entitiesFound: result.entities.length,
          relationshipsFound: result.relationships.length,
          summary: result.summary,
          entities: result.entities,
          relationships: result.relationships,
        });
      }

      // ── 3. AI Graph Insights ──
      case 'graph-insights': {
        const { communities, influencers, bridges, stanceData } = body;
        if (!communities && !influencers) {
          return NextResponse.json({ error: 'Provide communities, influencers, bridges, or stanceData arrays' }, { status: 400 });
        }

        const insights = await aiIntegration.analyzeGraph(
          communities || [],
          influencers || [],
          bridges || [],
          stanceData || {},
        );

        return NextResponse.json({
          success: true,
          insightCount: insights.length,
          insights,
        });
      }

      // ── 4. AI Graph Narrative ──
      case 'graph-narrative': {
        const { analysisSummary } = body;
        if (!analysisSummary) {
          return NextResponse.json({ error: 'analysisSummary required' }, { status: 400 });
        }

        const narrative = await aiIntegration.generateGraphNarrative(analysisSummary);

        return NextResponse.json({
          success: true,
          narrative,
        });
      }

      default:
        return NextResponse.json({
          actions: {
            'resolve-identity': 'AI-powered entity matching — provide entityIdA and entityIdB',
            'parse-feed': 'AI-powered connector parsing — provide rawData and source',
            'graph-insights': 'AI-powered graph insights — provide communities, influencers, bridges arrays',
            'graph-narrative': 'AI-generated graph narrative — provide analysisSummary string',
          },
        });
    }
  } catch (e: any) {
    console.error('[AIIntegration] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    name: 'OSIRIS AI Integration Hub',
    description: 'Wires AI into Identity Resolution, Connectors, and Graph Analytics',
    usage: {
      'POST /api/ai/integrate': {
        'resolve-identity': 'AI-powered entity matching between two entities',
        'parse-feed': 'AI-powered extraction of entities/relationships from raw data',
        'graph-insights': 'AI-powered analysis of graph communities and influencers',
        'graph-narrative': 'AI-generated intelligence narrative from graph data',
      },
    },
  });
}
