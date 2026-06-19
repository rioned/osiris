/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Social Graph Reconstruction API
 *
 *  POST /api/connectors/reconstruct-social
 *
 *  Accepts raw social feed data from any connector and runs the
 *  social interaction graph reconstruction engine:
 *    - Parses the feed into typed SocialInteractions
 *    - Upserts actor and object entities into the ontology store
 *    - Creates typed, directional relationships (follows, liked,
 *      commented_on, replied_to, shared, mentioned, tagged,
 *      member_of, works_at, friend_of)
 *
 *  Alternatively, accepts a pre-structured batch of
 *  SocialInteraction objects for direct reconstruction.
 *
 *  Body:
 *    { connector: 'twitter'|'youtube'|'facebook'|'linkedin'|'whatsapp',
 *      rawData: string,        // the raw connector output text
 *      interactions: [...]     // OR pre-structured SocialInteraction[]
 *      source: string }        // optional source label
 *
 *  Returns:
 *    { success, entitiesCreated, relationshipsCreated,
 *      breakdown, warnings, totalInteractions }
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  reconstructSocialGraph,
  parseTwitterFeed,
  parseYouTubeFeed,
  parseGenericFeed,
  type SocialInteraction,
} from '@/lib/social-graph-reconstruction';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { connector, rawData, interactions: preParsedInteractions, source } = body;

    // Support direct structured interactions (for clients that pre-parse their data).
    if (preParsedInteractions && Array.isArray(preParsedInteractions)) {
      const interactions = preParsedInteractions as SocialInteraction[];
      if (interactions.length === 0) {
        return NextResponse.json({
          success: true,
          entitiesCreated: 0,
          relationshipsCreated: 0,
          breakdown: {},
          warnings: ['No interactions provided'],
          totalInteractions: 0,
        });
      }

      const result = await reconstructSocialGraph(interactions, source || 'api_reconstruction');
      return NextResponse.json({
        success: true,
        ...result,
      });
    }

    // Require rawData for feed parsing.
    if (!rawData || !connector) {
      return NextResponse.json({
        success: false,
        error: 'Provide either (connector + rawData) for auto-parsing or (interactions[]) for direct reconstruction',
      }, { status: 400 });
    }

    // Auto-parse based on connector type.
    let interactions: SocialInteraction[] = [];

    switch (connector) {
      case 'twitter':
        interactions = parseTwitterFeed(rawData);
        break;
      case 'youtube':
        interactions = parseYouTubeFeed(rawData);
        break;
      case 'facebook':
      case 'linkedin':
      case 'whatsapp':
      case 'telegram':
        interactions = parseGenericFeed(rawData, connector);
        break;
      default:
        interactions = parseGenericFeed(rawData, 'generic');
        break;
    }

    if (interactions.length === 0) {
      return NextResponse.json({
        success: true,
        entitiesCreated: 0,
        relationshipsCreated: 0,
        breakdown: {},
        warnings: ['No social interactions could be parsed from the provided data'],
        totalInteractions: 0,
        note: 'Try passing structured interactions[] directly if the auto-parser cannot handle this format',
      });
    }

    const result = await reconstructSocialGraph(interactions, source || `connector_${connector}`);

    return NextResponse.json({
      success: true,
      connector,
      ...result,
    });
  } catch (e: any) {
    console.error('[ReconstructSocial] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
