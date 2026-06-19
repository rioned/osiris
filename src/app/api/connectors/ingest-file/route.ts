/**
 * OSIRIS — Direct File Ingest Endpoint
 * Parses structured synthetic data files and stores them directly
 * into the ontology entity store, bypassing AI extraction.
 */
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function persistToStore(entities: any[], relationships: any[], baseUrl: string) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/ontology/entities`;
  let ec = 0, rc = 0;
  
  if (entities.length > 0) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'batch', entities }),
      });
      if (r.ok) { const d = await r.json(); ec = d.count || 0; }
    } catch {}
  }
  
  for (const rel of relationships.slice(0, 500)) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'relate', sourceId: rel.sourceId, targetId: rel.targetId,
          label: rel.label || 'related_to', strength: rel.strength || 0.8,
        }),
      });
      if (r.ok) rc++;
    } catch {}
  }
  return { entities: ec, relationships: rc };
}

function extractPeopleNames(data: any): string[] {
  const names = new Set<string>();
  const extract = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.length > 2 && v.length < 100 && /^[A-Z][a-z]+ [A-Z]/.test(v)) names.add(v);
      else if (Array.isArray(v)) v.forEach(extract);
      else if (typeof v === 'object') extract(v);
    }
  };
  extract(data);
  return [...names].slice(0, 2000);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fileData } = body;
    if (!fileData) return NextResponse.json({ error: 'No fileData provided' }, { status: 400 });
    
    const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    const now = new Date().toISOString();
    const entities: any[] = [];
    const relationships: any[] = [];
    let personIdCounter = 0;
    const nextId = (prefix: string) => `${prefix}_${Date.now()}_${++personIdCounter}`;

    // Extract all person-like names from the data
    const names = extractPeopleNames(fileData);
    
    for (const name of names) {
      const pid = nextId('person');
      entities.push({
        id: pid, type: 'person', domain: 'PERSON', label: name,
        description: 'Extracted from synthetic data',
        properties: { name }, tags: ['synthetic'], source: 'synthetic-ingest',
        createdAt: now, updatedAt: now,
      });
    }

    // Process top-level arrays of objects
    for (const [key, arr] of Object.entries(fileData)) {
      if (!Array.isArray(arr)) continue;
      const src = key.replace(/[^a-z0-9]/gi, '_');
      
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const label = item.name || item.title || item.displayName || item.username || item.person_name || item.contact_name || `${src}_item`;
        const eid = nextId(src);
        entities.push({
          id: eid, type: src === 'person_ids' ? 'person' : src === 'phone_contacts' ? 'phone_number' : src === 'profiles' ? 'social_profile' : src === 'channels' ? 'social_profile' : src === 'pages' ? 'social_profile' : 'person',
          domain: 'PERSON', label: String(label).slice(0, 200),
          description: `From ${src} synthetic data`,
          properties: Object.fromEntries(Object.entries(item).filter(([k, v]) => typeof v === 'string' || typeof v === 'number').slice(0, 20)),
          tags: ['synthetic', src], source: 'synthetic-ingest',
          createdAt: now, updatedAt: now,
        });
      }
    }

    const result = await persistToStore(entities, relationships, baseUrl);
    
    return NextResponse.json({
      success: true,
      entitiesCreated: result.entities,
      relationshipsCreated: result.relationships,
      totalNames: names.length,
      totalItems: entities.length,
      summary: `Persisted ${result.entities} entities and ${result.relationships} relationships`,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
