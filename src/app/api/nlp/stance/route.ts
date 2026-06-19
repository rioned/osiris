/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Stance & Opinion Mining API
 *
 *  POST /api/nlp/stance
 *    Analyze stance toward targets in a single text.
 *    Body: { text, interactionType?, date?
 *
 *  POST /api/nlp/stance/aggregate
 *    Compute aggregate stance from multiple texts.
 *    Body: { texts: [{ text, type, date }] }
 *
 *  GET /api/nlp/stance?entityId=...
 *    Get stance profiles for an entity (reads from entity properties).
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { analyzeStance, runStanceIntegration, stanceProfilesToProperties, listStanceTargets, getStanceToward } from '@/lib/nlp/stance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || 'analyze';

    switch (action) {
      case 'analyze': {
        const text = body.text || '';
        const interactionType = body.interactionType || 'post';
        const date = body.date || new Date().toISOString();

        if (!text.trim()) {
          return NextResponse.json({ error: 'No text provided' }, { status: 400 });
        }

        const result = analyzeStance(text, interactionType, date);
        return NextResponse.json({
          success: true,
          ...result,
        });
      }

      case 'aggregate': {
        const texts: { text: string; type: string; date: string }[] = body.texts || [];
        if (texts.length === 0) {
          return NextResponse.json({ error: 'No texts provided' }, { status: 400 });
        }

        // Simulate an actor
        const actorId = body.actorId || `analysis_${Date.now()}`;
        let profiles: Record<string, any> | null = null;

        for (const t of texts) {
          const result = runStanceIntegration(
            actorId,
            t.text,
            (t.type as any) || 'post',
            t.date || new Date().toISOString(),
            profiles,
          );
          profiles = result.updatedProfiles;
        }

        return NextResponse.json({
          success: true,
          profiles,
          targets: listStanceTargets(profiles),
          stanceProperties: profiles ? stanceProfilesToProperties(profiles) : null,
        });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[Stance] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const entityId = searchParams.get('entityId');
    const target = searchParams.get('target');

    if (!entityId) {
      return NextResponse.json({
        // Return simple stance analysis of a query text as a demo/help
        demo: 'Pass ?entityId=... to get stance profiles for an entity, or POST text to analyze',
        usage: {
          entityProfile: 'GET /api/nlp/stance?entityId=xxx&target=optional_target',
          analyze: 'POST /api/nlp/stance with { text: "..." }',
        },
      });
    }

    // Fetch entity from ontology store
    const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    const entityRes = await fetch(`${baseUrl}/api/ontology/entities?id=${encodeURIComponent(entityId)}`);
    if (!entityRes.ok) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }
    const entityData = await entityRes.json();
    const entity = entityData.entity || entityData;
    const properties = entity.properties || {};
    const stanceProfiles = properties.stance_profiles || null;

    if (target) {
      const profile = getStanceToward(stanceProfiles, target);
      return NextResponse.json({
        entityId,
        entityLabel: entity.label,
        target,
        profile,
      });
    }

    return NextResponse.json({
      entityId,
      entityLabel: entity.label,
      targets: listStanceTargets(stanceProfiles),
      profiles: stanceProfiles,
      stanceProperties: stanceProfiles ? stanceProfilesToProperties(stanceProfiles) : null,
    });
  } catch (e: any) {
    console.error('[Stance] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
