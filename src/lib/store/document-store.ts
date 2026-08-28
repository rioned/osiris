/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Data Fusion: Unstructured Document Store
 *
 *  The missing half of the ontology store. `entity-store.ts` holds
 *  STRUCTURED objects (people, vessels, phones, ...) and the links
 *  between them. This module is the ingestion + index path for
 *  UNSTRUCTURED material (reports, pages, transcripts, OCR output):
 *
 *    raw text ─▶ chunk ─▶ full-text index ─▶ NER ─▶ resolve against
 *    existing entities (or create new ones) ─▶ write "mentioned_in" /
 *    "mentioned_with" relationships back into the SAME entity graph.
 *
 *  The ingested document itself becomes a first-class `media` node,
 *  so a search never returns an orphaned blob of text — it always
 *  arrives already wired into the ontology's web of relationships.
 *  This is the Foundry-style fusion loop described in
 *  osiris-foundation/ARCHITECTURE_ROADMAP.md §2 ("the unstructured-
 *  data thesis"), implemented against the store this app actually
 *  runs (entity-store's flat tables) rather than the aspirational
 *  AGE/pgvector schema those docs sketch out — same graceful
 *  Postgres-or-memory fallback pattern as entity-store.ts.
 * ═══════════════════════════════════════════════════════════════
 */

import { createHash } from 'crypto';
import { query, isDBAvailable, initDB } from './db';
import {
  getEntities, getEntity, upsertEntity, createRelationship, getRelationships,
} from './entity-store';
import { generateEntityId } from '../personal-ontology';
import { extractNamedEntities, type NamedEntity } from '../nlp/pipeline';

// ── Types ──

export interface IngestSource {
  id: string;
  kind: string;            // file | image | audio | url | text | manual
  title: string;
  uri?: string;
  sha256?: string;
  mime?: string;
  bytes: number;
  docEntityId: string;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface ChunkHit {
  chunkId: string;
  sourceId: string;
  docEntityId: string;
  title: string;
  uri?: string;
  kind: string;
  seq: number;
  snippet: string;
  rank: number;
}

export interface IngestResult {
  sourceId: string;
  docEntityId: string;
  deduped: boolean;
  chunkCount: number;
  entitiesLinked: { id: string; label: string; type: string; created: boolean; mentions: number }[];
  relationshipsCreated: number;
}

// ── In-memory fallback ──

interface MemChunk { id: string; sourceId: string; seq: number; text: string; }
let memSources: IngestSource[] = [];
let memChunks: MemChunk[] = [];

// ── Store init ──

let initialized = false;
let tsvAvailable = false;

async function ensureDocStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const avail = await initDB();
  if (!avail) {
    console.log('[DocumentStore] Using in-memory fallback');
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS ontology_sources (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL DEFAULT 'text',
      title         TEXT NOT NULL,
      uri           TEXT,
      sha256        TEXT,
      mime          TEXT,
      bytes         INTEGER DEFAULT 0,
      doc_entity_id TEXT,
      metadata      JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_sha ON ontology_sources(sha256) WHERE sha256 IS NOT NULL');

  // Try the fast path: a generated tsvector column + GIN index for
  // ranked full-text search. Older Postgres (<12) lacks generated
  // columns — fall back to a plain table and ILIKE search below.
  await query(`
    CREATE TABLE IF NOT EXISTS ontology_chunks (
      id         TEXT PRIMARY KEY,
      source_id  TEXT NOT NULL REFERENCES ontology_sources(id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL DEFAULT 0,
      text       TEXT NOT NULL,
      tsv        tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const col = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'ontology_chunks' AND column_name = 'tsv'`
  );
  tsvAvailable = !!col?.rows?.length;

  if (!tsvAvailable) {
    // Generated-column create failed outright (whole statement aborts on
    // unsupported syntax) — the table may not exist at all. Lay down the
    // plain version instead so chunk inserts always have somewhere to go.
    await query(`
      CREATE TABLE IF NOT EXISTS ontology_chunks (
        id         TEXT PRIMARY KEY,
        source_id  TEXT NOT NULL REFERENCES ontology_sources(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL DEFAULT 0,
        text       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } else {
    await query('CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON ontology_chunks USING GIN(tsv)');
  }
  await query('CREATE INDEX IF NOT EXISTS idx_chunks_source ON ontology_chunks(source_id)');

  console.log(`[DocumentStore] Ready (full-text index: ${tsvAvailable ? 'tsvector' : 'ILIKE fallback'})`);
}

// ── Helpers ──

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Sliding-window chunker. Overlap keeps entity mentions from being split across a chunk boundary. */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let i = 0;
  const MAX_CHUNKS = 300; // safety cap so one huge document can't flood the store
  while (i < clean.length && chunks.length < MAX_CHUNKS) {
    chunks.push(clean.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

function mimeToKind(mime?: string, kindHint?: string): string {
  if (kindHint === 'image') return 'image';
  if (kindHint === 'audio') return 'audio';
  if (kindHint === 'video') return 'video';
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('video/')) return 'video';
  return 'document';
}

// NER type → ontology object type. Only signal-bearing entity kinds become
// graph nodes — dates/money/urls/hashtags stay as chunk text, not nodes,
// to keep the fused graph readable rather than flooded with noise.
const NER_TYPE_MAP: Record<string, string> = {
  person: 'person',
  organization: 'organization',
  location: 'place',
  email: 'email_address',
  phone: 'phone_number',
  ip_address: 'network_node',
};
const TYPE_PRIORITY = ['person', 'place', 'network_node', 'email_address', 'phone_number', 'organization'];

function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

interface ResolvedMention {
  objectType: string;
  name: string;
  confidence: number;
  mentions: number;
}

/** Dedupe raw NER hits into one best candidate per (normalized text), across types. */
function dedupeMentions(entities: NamedEntity[]): ResolvedMention[] {
  const byKey = new Map<string, ResolvedMention>();
  for (const e of entities) {
    const objectType = NER_TYPE_MAP[e.type];
    if (!objectType) continue;
    const name = normalizeName(e.text);
    if (name.length < 2 || name.length > 120) continue;
    if (e.confidence < 0.5) continue;
    const key = name.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { objectType, name, confidence: e.confidence, mentions: 1 });
    } else {
      existing.mentions++;
      const existingPriority = TYPE_PRIORITY.indexOf(existing.objectType);
      const newPriority = TYPE_PRIORITY.indexOf(objectType);
      if (e.confidence > existing.confidence || (e.confidence === existing.confidence && newPriority < existingPriority)) {
        existing.objectType = objectType;
        existing.confidence = e.confidence;
      }
    }
  }
  return [...byKey.values()];
}

/** Find an existing entity that already represents this name, or create one. */
async function resolveOrCreateEntity(
  m: ResolvedMention, docTitle: string
): Promise<{ id: string; label: string; type: string; created: boolean }> {
  const { entities } = await getEntities({ type: m.objectType, search: m.name, limit: 5 });
  const target = m.name.toLowerCase();
  const match = entities.find(e => e.label.toLowerCase() === target)
    || entities.find(e => e.label.toLowerCase().includes(target) || target.includes(e.label.toLowerCase()));

  if (match) return { id: match.id, label: match.label, type: match.type, created: false };

  const id = generateEntityId(m.objectType);
  const created = await upsertEntity({
    id,
    type: m.objectType as any,
    label: m.name,
    description: `Extracted from document: ${docTitle}`,
    properties: { extracted: true, mentions: m.mentions, confidence: Math.round(m.confidence * 100) / 100 },
    tags: ['extracted', 'document-fusion'],
    source: 'document-fusion',
  });
  return { id: created.id, label: created.label, type: created.type, created: true };
}

// ── Ingestion ──

export interface IngestInput {
  title: string;
  text: string;
  kind?: string;      // file | image | audio | url | text
  mime?: string;
  uri?: string;
  metadata?: Record<string, any>;
}

/**
 * Ingest one unstructured document: index it for full-text search AND
 * fuse it into the entity graph (extract entities, link them to the
 * document and to each other). Idempotent — re-ingesting identical text
 * returns the existing source rather than duplicating it.
 */
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  await ensureDocStore();

  const text = (input.text || '').trim();
  if (!text) throw new Error('No text content to ingest');

  const hash = sha256Hex(text);
  const kind = input.kind || 'text';

  // Dedup: identical content already ingested → return the existing wiring.
  const existing = isDBAvailable()
    ? (await query('SELECT * FROM ontology_sources WHERE sha256 = $1', [hash]))?.rows?.[0]
    : memSources.find(s => s.sha256 === hash);
  if (existing) {
    const docEntityId = existing.doc_entity_id || existing.docEntityId;
    const rels = await getRelationships({ entityId: docEntityId });
    const mentionRels = rels.filter(r => r.label === 'mentioned_in' && r.targetId === docEntityId);
    const linkedEntities = await Promise.all(mentionRels.map(async r => {
      const ent = await getEntity(r.sourceId);
      return { id: r.sourceId, label: ent?.label || r.sourceId, type: ent?.type || '', created: false, mentions: r.metadata?.mentions || 0 };
    }));
    return {
      sourceId: existing.id,
      docEntityId,
      deduped: true,
      chunkCount: isDBAvailable()
        ? Number((await query('SELECT COUNT(*) c FROM ontology_chunks WHERE source_id = $1', [existing.id]))?.rows?.[0]?.c ?? 0)
        : memChunks.filter(c => c.sourceId === existing.id).length,
      entitiesLinked: linkedEntities,
      relationshipsCreated: 0,
    };
  }

  const sourceId = `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const docEntityId = `doc_${sourceId}`;
  const title = input.title?.trim() || `Untitled ${kind}`;
  const objectKind = mimeToKind(input.mime, kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : undefined);

  // 1. Provenance row
  if (isDBAvailable()) {
    await query(
      `INSERT INTO ontology_sources (id, kind, title, uri, sha256, mime, bytes, doc_entity_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [sourceId, kind, title, input.uri || null, hash, input.mime || null, text.length, docEntityId, JSON.stringify(input.metadata || {})]
    );
  } else {
    memSources.push({
      id: sourceId, kind, title, uri: input.uri, sha256: hash, mime: input.mime,
      bytes: text.length, docEntityId, metadata: input.metadata || {}, createdAt: new Date().toISOString(),
    });
  }

  // 2. Chunk + full-text index
  const chunks = chunkText(text);
  if (isDBAvailable()) {
    for (let i = 0; i < chunks.length; i++) {
      await query(
        'INSERT INTO ontology_chunks (id, source_id, seq, text) VALUES ($1,$2,$3,$4)',
        [`chk_${sourceId}_${i}`, sourceId, i, chunks[i]]
      );
    }
  } else {
    chunks.forEach((c, i) => memChunks.push({ id: `chk_${sourceId}_${i}`, sourceId, seq: i, text: c }));
  }

  // 3. The document itself becomes a graph node (`media`, per the
  //    declarative ontology in osiris-foundation/ontology/object-types.yaml)
  await upsertEntity({
    id: docEntityId,
    type: 'media' as any,
    label: title,
    description: `${objectKind} · ${chunks.length} chunk(s) · ingested via Data Fusion`,
    properties: {
      kind: objectKind, uri: input.uri || null, mime: input.mime || null,
      chunkCount: chunks.length, transcript: text.slice(0, 4000),
    },
    tags: ['document-fusion', kind],
    source: 'document-fusion',
  });

  // 4. NER over the document (capped — huge docs would waste CPU on regex
  //    entity extraction past the point of diminishing returns).
  const nerText = text.slice(0, 20000);
  const mentions = dedupeMentions(extractNamedEntities(nerText))
    .sort((a, b) => b.confidence - a.confidence || b.mentions - a.mentions)
    .slice(0, 40);

  // 5. Resolve/create + link each mention to the document
  const resolved: { id: string; label: string; type: string; created: boolean; mentions: number }[] = [];
  let relationshipsCreated = 0;
  for (const m of mentions) {
    const ent = await resolveOrCreateEntity(m, title);
    resolved.push({ ...ent, mentions: m.mentions });
    await createRelationship({
      sourceId: ent.id,
      targetId: docEntityId,
      label: 'mentioned_in',
      strength: Math.min(1, m.confidence),
      metadata: { sourceId, mentions: m.mentions },
    });
    relationshipsCreated++;
  }

  // 6. Co-mention links between entities found in the same document —
  //    capped so pairwise linking stays O(1)-ish (top 12 → ≤66 pairs).
  const top = resolved.slice(0, 12);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      await createRelationship({
        sourceId: top[i].id,
        targetId: top[j].id,
        label: 'mentioned_with',
        strength: 0.5,
        metadata: { sourceId, via: docEntityId },
      });
      relationshipsCreated++;
    }
  }

  return {
    sourceId,
    docEntityId,
    deduped: false,
    chunkCount: chunks.length,
    entitiesLinked: resolved,
    relationshipsCreated,
  };
}

// ── Search ──

function buildSnippet(text: string, query: string, radius = 140): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0] || '');
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Full-text search over ingested document chunks. */
export async function searchChunks(q: string, limit = 15): Promise<ChunkHit[]> {
  await ensureDocStore();
  const query_ = q.trim();
  if (!query_) return [];

  if (!isDBAvailable()) {
    const needle = query_.toLowerCase();
    return memChunks
      .filter(c => c.text.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(c => {
        const src = memSources.find(s => s.id === c.sourceId);
        return {
          chunkId: c.id, sourceId: c.sourceId, docEntityId: src?.docEntityId || `doc_${c.sourceId}`,
          title: src?.title || 'Untitled', uri: src?.uri, kind: src?.kind || 'text',
          seq: c.seq, snippet: buildSnippet(c.text, query_), rank: 1,
        };
      });
  }

  if (tsvAvailable) {
    const result = await query(
      `SELECT c.id, c.source_id, c.seq, c.text, s.title, s.uri, s.kind, s.doc_entity_id,
              ts_rank(c.tsv, websearch_to_tsquery('english', $1)) AS rank
       FROM ontology_chunks c JOIN ontology_sources s ON s.id = c.source_id
       WHERE c.tsv @@ websearch_to_tsquery('english', $1)
       ORDER BY rank DESC LIMIT $2`,
      [query_, limit]
    );
    if (result?.rows?.length) {
      return result.rows.map(r => ({
        chunkId: r.id, sourceId: r.source_id, docEntityId: r.doc_entity_id,
        title: r.title, uri: r.uri, kind: r.kind, seq: r.seq,
        snippet: buildSnippet(r.text, query_), rank: parseFloat(r.rank) || 0,
      }));
    }
  }

  // ILIKE fallback — either tsv isn't available, or the tsquery matched
  // nothing (e.g. the query is a raw token tsquery can't parse cleanly).
  const result = await query(
    `SELECT c.id, c.source_id, c.seq, c.text, s.title, s.uri, s.kind, s.doc_entity_id
     FROM ontology_chunks c JOIN ontology_sources s ON s.id = c.source_id
     WHERE c.text ILIKE $1 ORDER BY c.seq ASC LIMIT $2`,
    [`%${query_}%`, limit]
  );
  return (result?.rows || []).map(r => ({
    chunkId: r.id, sourceId: r.source_id, docEntityId: r.doc_entity_id,
    title: r.title, uri: r.uri, kind: r.kind, seq: r.seq,
    snippet: buildSnippet(r.text, query_), rank: 1,
  }));
}

export async function getSourceCounts(): Promise<{ sources: number; chunks: number; source: 'postgres' | 'memory' }> {
  await ensureDocStore();
  if (!isDBAvailable()) return { sources: memSources.length, chunks: memChunks.length, source: 'memory' };
  const s = await query('SELECT COUNT(*) c FROM ontology_sources');
  const c = await query('SELECT COUNT(*) c FROM ontology_chunks');
  return { sources: Number(s?.rows?.[0]?.c || 0), chunks: Number(c?.rows?.[0]?.c || 0), source: 'postgres' };
}
