/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — NLP Content Enrichment API
 *
 *  POST /api/nlp/enrich
 *    Enrich a text string with NLP analysis.
 *    Body: { text: string, includeFull?: boolean }
 *    Returns: { language, entities, keywords, toxicity, stats, tags }
 *
 *  POST /api/nlp/enrich-batch
 *    Enrich multiple texts in one request.
 *    Body: { texts: { id: string, text: string }[] }
 *    Returns: { results: { id, enrichment }[] }
 *
 *  POST /api/nlp/enrich-entity
 *    Enrich and update a specific entity in the ontology store.
 *    Body: { entityId: string, text?: string }
 *    Returns: { enriched properties }
 *
 *  GET /api/nlp/enrich?text=...
 *    Quick enrichment via query string (for testing).
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  enrichText,
  enrichEntityProperties,
  detectLanguage,
  extractNamedEntities,
  extractKeywords,
  scoreToxicity,
  computeTextStats,
} from '@/lib/nlp/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || 'enrich';
    const text = body.text || '';
    const includeFull = body.includeFull !== false;

    switch (action) {
      case 'enrich': {
        if (!text.trim()) {
          return NextResponse.json({ error: 'No text provided' }, { status: 400 });
        }

        const result = enrichText(text);

        return NextResponse.json({
          success: true,
          textLength: text.length,
          ...(includeFull ? result : {
            language: result.language,
            toxicity: result.toxicity,
            tags: result.tags,
            stats: { wordCount: result.stats.wordCount },
            enrichedProperties: result.enrichedProperties,
          }),
        });
      }

      case 'enrich-batch': {
        const texts: { id: string; text: string }[] = body.texts || [];
        if (texts.length === 0) {
          return NextResponse.json({ error: 'No texts provided' }, { status: 400 });
        }

        const results = texts.map(({ id, text: t }) => ({
          id,
          enrichment: t ? enrichText(t) : null,
        }));

        return NextResponse.json({ success: true, count: results.length, results });
      }

      case 'enrich-entity': {
        const entityId = body.entityId;
        const entityText = body.text || '';

        if (!entityId) {
          return NextResponse.json({ error: 'No entityId provided' }, { status: 400 });
        }

        if (!entityText.trim()) {
          return NextResponse.json({ error: 'No text to enrich' }, { status: 400 });
        }

        const enrichment = enrichText(entityText);
        const { properties, newTags } = enrichEntityProperties({}, enrichment);

        // Update the entity via the ontology entities API
        const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
        let updateResult = null;
        try {
          const updateRes = await fetch(`${baseUrl}/api/ontology/entities?id=${encodeURIComponent(entityId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              properties,
              tags: newTags,
            }),
          });
          if (updateRes.ok) {
            updateResult = await updateRes.json();
          }
        } catch (e: any) {
          // Non-fatal — enrichment result is still returned
        }

        return NextResponse.json({
          success: true,
          entityId,
          enrichment,
          updateResult,
        });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[NLP] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * GET /api/nlp/enrich?text=...
 * Quick enrichment via query string for testing.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const text = searchParams.get('text');

    if (!text) {
      return NextResponse.json({
        language: detectLanguage(''),
        entities: [],
        keywords: [],
        toxicity: { score: 0, categories: {}, flagged: false, threshold: 0.7 },
        stats: computeTextStats(''),
        tags: [],
        enrichedProperties: {},
      });
    }

    const result = enrichText(text);

    // Return a condensed response for GET (lighter than POST)
    return NextResponse.json({
      language: result.language,
      entityCount: result.entities.length,
      entities: result.entities.filter(e => e.confidence > 0.6).slice(0, 30),
      topKeywords: result.keywords.slice(0, 10).map(k => k.term),
      toxicity: result.toxicity,
      stats: {
        wordCount: result.stats.wordCount,
        readingTime: result.stats.readingTimeSeconds,
      },
      tags: result.tags,
      enrichedProperties: result.enrichedProperties,
    });
  } catch (e: any) {
    console.error('[NLP] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
