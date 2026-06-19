/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — GraphRAG Natural-Language Query API
 *
 *  POST /api/graphrag/query
 *    Ask a natural-language question that crosses stance scores,
 *    who-follows-whom, comment threads, shared groups, and
 *    entity relationships.
 *
 *    Body: { question: string }
 *    Returns: { answer, confidence, findings, stats }
 *
 *  GET /api/graphrag/query?question=...
 *    Quick query via query string.
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { answerQuestion, parseQuestion } from '@/lib/graphrag/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const question = body.question || '';
    const action = body.action || 'ask';

    if (!question.trim()) {
      return NextResponse.json({
        error: 'No question provided',
        usage: {
          ask: 'POST /api/graphrag/query with { "question": "..." }',
        },
      }, { status: 400 });
    }

    switch (action) {
      case 'ask': {
        const result = await answerQuestion(question);
        return NextResponse.json({
          success: true,
          question,
          ...result,
        });
      }

      case 'parse': {
        // Debug: just show how the question would be parsed
        const parsed = parseQuestion(question);
        return NextResponse.json({
          success: true,
          question,
          parsed: {
            type: parsed.type,
            description: parsed.description,
            confidence: parsed.confidence,
            plan: {
              seedType: parsed.plan.seedType,
              seedSearch: parsed.plan.seedSearch,
              seedTags: parsed.plan.seedTags,
              hops: parsed.plan.hops.map(h => ({
                relationship: h.relationship,
                direction: h.direction,
                targetType: h.targetType,
                label: h.label,
              })),
              stanceFilter: parsed.plan.stanceFilter,
              targetType: parsed.plan.targetType,
              maxResults: parsed.plan.maxResults,
            },
          },
        });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[GraphRAG] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const question = searchParams.get('question');
    const action = searchParams.get('action') || 'ask';

    if (!question) {
      return NextResponse.json({
        name: 'OSIRIS GraphRAG',
        description: 'Natural-language query engine over the ontology graph',
        usage: {
          query: 'GET /api/graphrag/query?question=...',
          parse_debug: 'GET /api/graphrag/query?question=...&action=parse',
          examples: [
            'users who don\'t like Rwanda',
            'who commented on this YouTube post and also follows X',
            'which contacts of this person work at the same company',
            'who follows @elonmusk',
            'find posts about climate change',
            'what does Alice think about Rwanda',
          ],
        },
      });
    }

    if (action === 'parse') {
      const parsed = parseQuestion(question);
      return NextResponse.json({
        success: true,
        question,
        parsed: {
          type: parsed.type,
          description: parsed.description,
          confidence: parsed.confidence,
          plan: {
            seedType: parsed.plan.seedType,
            seedSearch: parsed.plan.seedSearch,
            seedTags: parsed.plan.seedTags,
            hops: parsed.plan.hops,
            stanceFilter: parsed.plan.stanceFilter,
            targetType: parsed.plan.targetType,
            maxResults: parsed.plan.maxResults,
          },
        },
      });
    }

    const result = await answerQuestion(question);
    return NextResponse.json({
      success: true,
      question,
      ...result,
    });
  } catch (e: any) {
    console.error('[GraphRAG] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
