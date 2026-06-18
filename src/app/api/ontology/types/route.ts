/**
 * ════════════════════════════════════════════════════════════════
 *  OSIRIS — Ontology Type Definitions API
 *  Reads the declarative YAML ontology definitions and serves
 *  them as JSON to the frontend.
 *
 *  Steps2 improvement: Ontology types defined as data (YAML),
 *  not code — adding a new object type requires zero code changes.
 *
 *  The parsing/normalisation/fallback logic lives in
 *  `@/lib/ontology/registry` so this route and the boot-time DB
 *  loader (`@/lib/store/ontology-loader`) share one implementation
 *  and can never drift apart.
 * ════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import {
  parseObjectTypes,
  parseLinkTypes,
  getFallbackObjectTypes,
  getFallbackLinkTypes,
  type ObjectType,
  type LinkType,
} from '@/lib/ontology/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── Cached Parsed Ontology ──

let cachedTypes: { objectTypes: ObjectType[]; linkTypes: LinkType[] } | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

/**
 * GET /api/ontology/types
 * Returns all object and link type definitions.
 */
export async function GET() {
  try {
    const now = Date.now();
    if (cachedTypes && (now - cacheTime) < CACHE_TTL) {
      return NextResponse.json(cachedTypes);
    }

    const [objectTypes, linkTypes] = await Promise.all([
      parseObjectTypes(),
      parseLinkTypes(),
    ]);

    cachedTypes = { objectTypes, linkTypes };
    cacheTime = now;

    return NextResponse.json({ objectTypes, linkTypes });
  } catch (e: any) {
    console.error('[OntologyTypes] Error:', e.message);
    // Return fallback types rather than failing
    return NextResponse.json({
      objectTypes: getFallbackObjectTypes(),
      linkTypes: getFallbackLinkTypes(),
    });
  }
}
