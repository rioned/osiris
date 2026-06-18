/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Ontology Entity & Relationship Store
 *  Manages personal ontology entities with Postgres + AGE persistence
 *  Falls back to in-memory storage when DB is unavailable
 *
 *  Steps2-inspired improvements:
 *  - Formal ontology types as data (matching object-types.yaml)
 *  - Durable entity + relationship CRUD
 *  - Graph query support via AGE
 *  - Auto cross-referencing on entity add
 * ═══════════════════════════════════════════════════════════════
 */

import { query, isDBAvailable, graphQuery, initDB } from './db';
import { loadOntologyRegistry } from './ontology-loader';
import { PersonalEntity, PersonalRelationship, PersonalDomain } from '../personal-ontology';

// ── In-Memory Fallback ──

interface MemoryStore {
  entities: PersonalEntity[];
  relationships: PersonalRelationship[];
}

let memStore: MemoryStore = { entities: [], relationships: [] };

// ── Initialisation ──

let initialized = false;

/**
 * Ensure the store is ready — creates DB tables if needed.
 */
export async function ensureStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const avail = await initDB();
  if (!avail) {
    console.log('[OntologyStore] Using in-memory fallback');
    return;
  }

  // Create ontology tables if they don't exist (idempotent)
  await query(`
    CREATE TABLE IF NOT EXISTS ontology_entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      domain TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT DEFAULT '',
      coordinates JSONB,
      properties JSONB DEFAULT '{}',
      tags TEXT[] DEFAULT '{}',
      source TEXT DEFAULT 'manual',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ontology_relationships (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      strength REAL DEFAULT 0.5,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Create search indexes
  await query('CREATE INDEX IF NOT EXISTS idx_ontology_type ON ontology_entities(type)');
  await query('CREATE INDEX IF NOT EXISTS idx_ontology_domain ON ontology_entities(domain)');
  await query('CREATE INDEX IF NOT EXISTS idx_ontology_label ON ontology_entities(label)');
  await query('CREATE INDEX IF NOT EXISTS idx_ontology_tags ON ontology_entities USING GIN(tags)');
  await query('CREATE INDEX IF NOT EXISTS idx_ontology_rel_source ON ontology_relationships(source_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_ontology_rel_target ON ontology_relationships(target_id)');

  // Governance: immutable audit log (matches osiris-foundation/db/init/10_ontology_schema.sql).
  // Append-only — every entity/relationship write records who did what, when.
  await query(`
    CREATE SCHEMA IF NOT EXISTS ontology;
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS ontology.audit_log (
      id          BIGSERIAL PRIMARY KEY,
      actor       TEXT NOT NULL,
      action      TEXT NOT NULL,
      object_type TEXT,
      object_id   TEXT,
      detail      JSONB NOT NULL DEFAULT '{}',
      at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS ix_audit_object ON ontology.audit_log(object_type, object_id)');

  // Sync the declarative ontology type registry (object/link types) from
  // osiris-foundation/ontology/*.yaml into ontology.object_types / link_types.
  await loadOntologyRegistry();

  console.log('[OntologyStore] DB tables ready');
}

/**
 * Append an immutable audit entry. Governance per the foundation roadmap:
 * every write to the ontology is recorded and never updated or deleted.
 * Best-effort — a logging failure must never break the underlying operation.
 */
async function writeAudit(
  action: string,
  objectType: string | null,
  objectId: string | null,
  detail: Record<string, any> = {},
  actor = 'system'
): Promise<void> {
  if (!isDBAvailable()) return;
  try {
    await query(
      `INSERT INTO ontology.audit_log (actor, action, object_type, object_id, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actor, action, objectType, objectId, JSON.stringify(detail)]
    );
  } catch {
    /* audit is best-effort — never throw */
  }
}

// ── Entity CRUD ──

/**
 * Get all entities, optionally filtered by type or domain.
 */
export async function getEntities(options?: {
  type?: string;
  domain?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ entities: PersonalEntity[]; total: number }> {
  await ensureStore();

  if (!isDBAvailable()) {
    let filtered = [...memStore.entities];
    if (options?.type) filtered = filtered.filter(e => e.type === options.type);
    if (options?.domain) filtered = filtered.filter(e => e.domain === options.domain as PersonalDomain);
    if (options?.search) {
      const q = options.search.toLowerCase();
      filtered = filtered.filter(e =>
        e.label.toLowerCase().includes(q) ||
        e.description?.toLowerCase().includes(q) ||
        e.tags.some(t => t.toLowerCase().includes(q))
      );
    }
    const total = filtered.length;
    const offset = options?.offset || 0;
    const limit = options?.limit || 100;
    return { entities: filtered.slice(offset, offset + limit), total };
  }

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (options?.type) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(options.type);
  }
  if (options?.domain) {
    conditions.push(`domain = $${paramIdx++}`);
    params.push(options.domain);
  }
  if (options?.search) {
    conditions.push(`(label ILIKE $${paramIdx} OR description ILIKE $${paramIdx} OR $${paramIdx} = ANY(tags))`);
    params.push(`%${options.search}%`);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit || 100;
  const offset = options?.offset || 0;

  const countResult = await query(`SELECT COUNT(*) as total FROM ontology_entities ${where}`, params);
  const total = countResult?.rows?.[0]?.total || 0;

  const result = await query(
    `SELECT * FROM ontology_entities ${where} ORDER BY updated_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset]
  );

  return {
    entities: (result?.rows || []).map(rowToEntity),
    total,
  };
}

/**
 * Get a single entity by ID.
 */
export async function getEntity(id: string): Promise<PersonalEntity | null> {
  await ensureStore();

  if (!isDBAvailable()) {
    return memStore.entities.find(e => e.id === id) || null;
  }

  const result = await query('SELECT * FROM ontology_entities WHERE id = $1', [id]);
  if (!result?.rows?.length) return null;
  return rowToEntity(result.rows[0]);
}

/**
 * Create or update an entity.
 */
export async function upsertEntity(entity: Partial<PersonalEntity> & { id: string; type: string; label: string }): Promise<PersonalEntity> {
  await ensureStore();

  const now = new Date().toISOString();
  const fullEntity: PersonalEntity = {
    id: entity.id,
    type: entity.type as any,
    domain: entity.domain || (mapDomainToPersonalDomain(entity.type) as PersonalDomain),
    label: entity.label,
    description: entity.description || '',
    coordinates: entity.coordinates || undefined,
    properties: entity.properties || {},
    tags: entity.tags || [],
    source: entity.source || 'manual',
    linkedEntityIds: entity.linkedEntityIds || [],
    createdAt: entity.createdAt || now,
    updatedAt: now,
  };

  if (!isDBAvailable()) {
    const idx = memStore.entities.findIndex(e => e.id === fullEntity.id);
    if (idx >= 0) {
      memStore.entities[idx] = { ...memStore.entities[idx], ...fullEntity, updatedAt: now };
    } else {
      memStore.entities.push(fullEntity);
    }
    return fullEntity;
  }

  await query(
    `INSERT INTO ontology_entities (id, type, domain, label, description, coordinates, properties, tags, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::text[], $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       type = EXCLUDED.type,
       domain = EXCLUDED.domain,
       label = EXCLUDED.label,
       description = EXCLUDED.description,
       coordinates = EXCLUDED.coordinates,
       properties = EXCLUDED.properties,
       tags = EXCLUDED.tags,
       source = EXCLUDED.source,
       updated_at = NOW()`,
    [
      fullEntity.id, fullEntity.type, fullEntity.domain, fullEntity.label,
      fullEntity.description,
      fullEntity.coordinates ? JSON.stringify(fullEntity.coordinates) : null,
      JSON.stringify(fullEntity.properties || {}),
      fullEntity.tags,
      fullEntity.source,
      fullEntity.createdAt,
      fullEntity.updatedAt,
    ]
  );

  await writeAudit('upsert', fullEntity.type, fullEntity.id, { label: fullEntity.label, domain: fullEntity.domain }, fullEntity.source || 'system');

  return fullEntity;
}

/**
 * Delete an entity and all its relationships.
 */
export async function deleteEntity(id: string): Promise<boolean> {
  await ensureStore();

  if (!isDBAvailable()) {
    const len = memStore.entities.length;
    memStore.entities = memStore.entities.filter(e => e.id !== id);
    memStore.relationships = memStore.relationships.filter(r => r.sourceId !== id && r.targetId !== id);
    return memStore.entities.length < len;
  }

  // CASCADE handles relationships
  const result = await query('DELETE FROM ontology_entities WHERE id = $1', [id]);
  const deleted = (result?.rowCount || 0) > 0;
  if (deleted) await writeAudit('delete', null, id);
  return deleted;
}

// ── Relationship CRUD ──

/**
 * Get all relationships, optionally filtered by entity.
 */
export async function getRelationships(options?: {
  entityId?: string;
  label?: string;
}): Promise<PersonalRelationship[]> {
  await ensureStore();

  if (!isDBAvailable()) {
    let filtered = [...memStore.relationships];
    if (options?.entityId) {
      filtered = filtered.filter(r => r.sourceId === options.entityId || r.targetId === options.entityId);
    }
    if (options?.label) {
      filtered = filtered.filter(r => r.label === options.label);
    }
    return filtered;
  }

  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (options?.entityId) {
    conditions.push(`(source_id = $${idx} OR target_id = $${idx})`);
    params.push(options.entityId);
    idx++;
  }
  if (options?.label) {
    conditions.push(`label = $${idx++}`);
    params.push(options.label);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(`SELECT * FROM ontology_relationships ${where} ORDER BY created_at DESC`, params);

  return (result?.rows || []).map(rowToRelationship);
}

/**
 * Create a relationship between two entities.
 */
export async function createRelationship(rel: {
  sourceId: string;
  targetId: string;
  label: string;
  strength?: number;
  metadata?: Record<string, any>;
}): Promise<PersonalRelationship> {
  await ensureStore();

  const id = `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const relationship: PersonalRelationship = {
    id,
    sourceId: rel.sourceId,
    targetId: rel.targetId,
    label: rel.label,
    strength: rel.strength ?? 0.8,
    metadata: rel.metadata || {},
    createdAt: now,
  };

  if (!isDBAvailable()) {
    memStore.relationships.push(relationship);
    // Also update linkedEntityIds on source/target
    for (const eid of [rel.sourceId, rel.targetId]) {
      const ent = memStore.entities.find(e => e.id === eid);
      if (ent) {
        ent.linkedEntityIds = [...new Set([...(ent.linkedEntityIds || []), rel.sourceId === eid ? rel.targetId : rel.sourceId])];
      }
    }
    return relationship;
  }

  await query(
    `INSERT INTO ontology_relationships (id, source_id, target_id, label, strength, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [id, rel.sourceId, rel.targetId, rel.label, rel.strength ?? 0.8, JSON.stringify(rel.metadata || {}), now]
  );

  await writeAudit('link', 'relationship', id, { sourceId: rel.sourceId, targetId: rel.targetId, label: rel.label });

  return relationship;
}

/**
 * Delete a relationship.
 */
export async function deleteRelationship(id: string): Promise<boolean> {
  await ensureStore();

  if (!isDBAvailable()) {
    const len = memStore.relationships.length;
    memStore.relationships = memStore.relationships.filter(r => r.id !== id);
    return memStore.relationships.length < len;
  }

  const result = await query('DELETE FROM ontology_relationships WHERE id = $1', [id]);
  const deleted = (result?.rowCount || 0) > 0;
  if (deleted) await writeAudit('unlink', 'relationship', id);
  return deleted;
}

// ── Backup / Restore ──

/** A full, unbounded snapshot of the ontology data (entities + relationships). */
export interface OntologySnapshot {
  entities: PersonalEntity[];
  relationships: PersonalRelationship[];
}

/**
 * Export EVERY entity and relationship in the store (no row limit) for a
 * full logical backup. Works in both Postgres and in-memory modes.
 * Unlike getGraph(), this is not capped — it is meant for backups.
 */
export async function exportSnapshot(): Promise<OntologySnapshot> {
  await ensureStore();

  if (!isDBAvailable()) {
    return {
      entities: memStore.entities.map(e => ({ ...e })),
      relationships: memStore.relationships.map(r => ({ ...r })),
    };
  }

  const [ents, rels] = await Promise.all([
    query('SELECT * FROM ontology_entities ORDER BY created_at ASC'),
    query('SELECT * FROM ontology_relationships ORDER BY created_at ASC'),
  ]);

  return {
    entities: (ents?.rows || []).map(rowToEntity),
    relationships: (rels?.rows || []).map(rowToRelationship),
  };
}

/** Quick counts for the backup UI — avoids serialising the whole store. */
export async function getStoreCounts(): Promise<{ entities: number; relationships: number; source: 'postgres' | 'memory' }> {
  await ensureStore();

  if (!isDBAvailable()) {
    return { entities: memStore.entities.length, relationships: memStore.relationships.length, source: 'memory' };
  }

  const [e, r] = await Promise.all([
    query('SELECT COUNT(*)::int AS c FROM ontology_entities'),
    query('SELECT COUNT(*)::int AS c FROM ontology_relationships'),
  ]);
  return { entities: e?.rows?.[0]?.c || 0, relationships: r?.rows?.[0]?.c || 0, source: 'postgres' };
}

/**
 * Restore a snapshot of entities + relationships.
 *  - 'replace' wipes ALL existing entities first (relationships cascade away),
 *    giving an exact restore of the backup.
 *  - 'merge' upserts the backup on top of existing data, preserving ids.
 * Relationships whose endpoints are missing are skipped rather than aborting
 * the whole restore. Returns how many rows were written / skipped.
 */
export async function restoreSnapshot(
  snapshot: OntologySnapshot,
  mode: 'merge' | 'replace' = 'merge',
  actor = 'admin'
): Promise<{ entities: number; relationships: number; skipped: number }> {
  await ensureStore();

  const entities = Array.isArray(snapshot?.entities) ? snapshot.entities : [];
  const relationships = Array.isArray(snapshot?.relationships) ? snapshot.relationships : [];

  // ── In-memory mode ──
  if (!isDBAvailable()) {
    if (mode === 'replace') memStore = { entities: [], relationships: [] };

    const byId = new Map(memStore.entities.map(e => [e.id, e]));
    for (const e of entities) {
      if (!e?.id || !e?.type || !e?.label) continue;
      byId.set(e.id, { ...e, domain: e.domain || (mapDomainToPersonalDomain(e.type) as PersonalDomain) });
    }
    memStore.entities = [...byId.values()];

    const validIds = new Set(memStore.entities.map(e => e.id));
    const relById = new Map(memStore.relationships.map(r => [r.id, r]));
    let skipped = 0;
    for (const r of relationships) {
      if (!r?.id || !validIds.has(r.sourceId) || !validIds.has(r.targetId)) { skipped++; continue; }
      relById.set(r.id, { ...r });
    }
    memStore.relationships = [...relById.values()];
    return { entities: memStore.entities.length, relationships: relationships.length - skipped, skipped };
  }

  // ── Postgres mode ──
  if (mode === 'replace') {
    await query('DELETE FROM ontology_entities'); // CASCADE clears relationships too
  }

  let entCount = 0;
  for (const e of entities) {
    if (!e?.id || !e?.type || !e?.label) continue;
    const domain = e.domain || mapDomainToPersonalDomain(e.type);
    const res = await query(
      `INSERT INTO ontology_entities (id, type, domain, label, description, coordinates, properties, tags, source, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::text[],$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         type=EXCLUDED.type, domain=EXCLUDED.domain, label=EXCLUDED.label,
         description=EXCLUDED.description, coordinates=EXCLUDED.coordinates,
         properties=EXCLUDED.properties, tags=EXCLUDED.tags, source=EXCLUDED.source,
         updated_at=EXCLUDED.updated_at`,
      [
        e.id, e.type, domain, e.label, e.description || '',
        e.coordinates ? JSON.stringify(e.coordinates) : null,
        JSON.stringify(e.properties || {}),
        e.tags || [],
        e.source || 'restore',
        e.createdAt || new Date().toISOString(),
        e.updatedAt || new Date().toISOString(),
      ]
    );
    if (res) entCount++;
  }

  // Insert relationships after entities so FK targets exist. A failed row
  // (e.g. missing endpoint) returns null from query() and is counted skipped.
  let relCount = 0, skipped = 0;
  for (const r of relationships) {
    if (!r?.id || !r?.sourceId || !r?.targetId || !r?.label) { skipped++; continue; }
    const res = await query(
      `INSERT INTO ontology_relationships (id, source_id, target_id, label, strength, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (id) DO UPDATE SET
         source_id=EXCLUDED.source_id, target_id=EXCLUDED.target_id,
         label=EXCLUDED.label, strength=EXCLUDED.strength, metadata=EXCLUDED.metadata`,
      [r.id, r.sourceId, r.targetId, r.label, r.strength ?? 0.5, JSON.stringify(r.metadata || {}), r.createdAt || new Date().toISOString()]
    );
    if (res) relCount++; else skipped++;
  }

  await writeAudit('restore', null, null, { mode, entities: entCount, relationships: relCount, skipped }, actor);

  return { entities: entCount, relationships: relCount, skipped };
}

// ── Graph Query ──

/**
 * Get full graph data (entities + relationships) for visualization.
 */
export async function getGraph(): Promise<{ entities: PersonalEntity[]; relationships: PersonalRelationship[] }> {
  await ensureStore();

  if (!isDBAvailable()) {
    return { entities: memStore.entities, relationships: memStore.relationships };
  }

  const [entitiesResult, relsResult] = await Promise.all([
    query('SELECT * FROM ontology_entities ORDER BY updated_at DESC LIMIT 500'),
    query('SELECT * FROM ontology_relationships ORDER BY created_at DESC LIMIT 1000'),
  ]);

  return {
    entities: (entitiesResult?.rows || []).map(rowToEntity),
    relationships: (relsResult?.rows || []).map(rowToRelationship),
  };
}

/**
 * Get neighborhood graph around an entity (expand operation).
 * Returns the entity, its direct relationships, and connected entities.
 */
export async function expandEntity(entityId: string, depth: number = 1): Promise<{
  entities: PersonalEntity[];
  relationships: PersonalRelationship[];
}> {
  await ensureStore();

  if (!isDBAvailable()) {
    const rels = memStore.relationships.filter(r => r.sourceId === entityId || r.targetId === entityId);
    const connectedIds = new Set<string>([entityId]);
    for (const r of rels) {
      connectedIds.add(r.sourceId);
      connectedIds.add(r.targetId);
    }
    return {
      entities: memStore.entities.filter(e => connectedIds.has(e.id)),
      relationships: rels,
    };
  }

  const rels = await query(
    `SELECT * FROM ontology_relationships WHERE source_id = $1 OR target_id = $1`,
    [entityId]
  );

  const relationships = (rels?.rows || []).map(rowToRelationship);
  const connectedIds = new Set<string>([entityId]);
  for (const r of relationships) {
    connectedIds.add(r.sourceId);
    connectedIds.add(r.targetId);
  }

  const entityIds = [...connectedIds];
  if (entityIds.length === 0) return { entities: [], relationships: [] };

  const placeholders = entityIds.map((_, i) => `$${i + 1}`).join(',');
  const entities = await query(
    `SELECT * FROM ontology_entities WHERE id IN (${placeholders})`,
    entityIds
  );

  return {
    entities: (entities?.rows || []).map(rowToEntity),
    relationships,
  };
}

// ── Auto Cross-Reference ──

/**
 * Run cross-reference rules against all entities and return new relationships.
 */
export async function runCrossReference(): Promise<PersonalRelationship[]> {
  await ensureStore();

  const { entities } = await getEntities({ limit: 1000 });
  const existing = await getRelationships();
  const existingKeys = new Set(existing.map(r => `${r.sourceId}:${r.targetId}:${r.label}`));
  const newRels: PersonalRelationship[] = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = 0; j < entities.length; j++) {
      if (i === j) continue;
      const src = entities[i];
      const tgt = entities[j];

      // Check each rule
      for (const rule of CROSS_REF_RULES) {
        if (rule.sourceType !== src.type || rule.targetType !== tgt.type) continue;
        const key = `${src.id}:${tgt.id}:${rule.label}`;
        if (existingKeys.has(key)) continue;
        const confidence = rule.match(src, tgt);
        if (confidence > 0.5) {
          const rel = await createRelationship({
            sourceId: src.id,
            targetId: tgt.id,
            label: rule.label,
            strength: confidence,
            metadata: { autoDiscovered: true, rule: rule.label },
          });
          newRels.push(rel);
          existingKeys.add(key);
        }
      }
      // ── Identity resolution pass (same_as): email/phone/name across types ──
      if (src.id !== tgt.id) {
        for (const rule of IDENTITY_RESOLUTION_RULES) {
          const key = `${src.id}:${tgt.id}:${rule.label}`;
          if (existingKeys.has(key)) continue;
          const confidence = rule.match(src, tgt);
          if (confidence > 0.5) {
            const rel = await createRelationship({
              sourceId: src.id,
              targetId: tgt.id,
              label: rule.label,
              strength: confidence,
              metadata: { autoDiscovered: true, rule: 'identity_resolution' },
            });
            newRels.push(rel);
            existingKeys.add(key);
          }
        }
      }
    }
  }

  return newRels;
}

// ── Helpers ──

function rowToEntity(row: any): PersonalEntity {
  return {
    id: row.id,
    type: row.type,
    domain: row.domain as PersonalDomain,
    label: row.label,
    description: row.description || '',
    coordinates: row.coordinates || undefined,
    properties: row.properties || {},
    tags: row.tags || [],
    source: row.source || 'manual',
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
  };
}

function rowToRelationship(row: any): PersonalRelationship {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    label: row.label,
    strength: row.strength || 0.5,
    metadata: row.metadata || {},
    createdAt: row.created_at || new Date().toISOString(),
  };
}

function mapDomainToPersonalDomain(type: string): string {
  const map: Record<string, string> = {
    person: 'PERSON', organization: 'PERSON',
    phone_number: 'COMMUNICATION', email_address: 'COMMUNICATION',
    social_profile: 'SOCIAL',
    identity_document: 'IDENTITY', personal_id: 'IDENTITY',
    vehicle: 'VEHICLE', vessel: 'SEA', aircraft: 'AIR',
    place: 'LOCATION',
    network_node: 'NETWORK', mac_address: 'NETWORK', wifi_network: 'NETWORK',
    event: 'EVENT',
    media: 'MEDIA', image_media: 'MEDIA',
  };
  return map[type] || 'PERSON';
}

// ── Support for Relationship interface with metadata ──
// Extend the PersonalRelationship type to include optional metadata
declare module '../personal-ontology' {
  interface PersonalRelationship {
    metadata?: Record<string, any>;
  }
}

// ── Cross-Reference Rules (moved from personal-ontology.ts to avoid circular) ──

type EntityType = PersonalEntity['type'];

const CROSS_REF_RULES: {
  sourceType: EntityType;
  targetType: EntityType;
  label: string;
  match: (src: PersonalEntity, tgt: PersonalEntity) => number;
}[] = [
  {
    sourceType: 'phone_number', targetType: 'person',
    label: 'contact_of',
    match: (src, tgt) => {
      const srcName = (src.properties.contactName || '').toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (srcName && tgtName && srcName.includes(tgtName)) return 0.9;
      return 0;
    },
  },
  {
    sourceType: 'phone_number', targetType: 'social_profile',
    label: 'linked_to',
    match: (src, tgt) => {
      const num = src.properties.number || src.label;
      const bio = (tgt.properties.bio || tgt.properties.description || '').toLowerCase();
      if (num && bio.includes(num.replace(/[^0-9]/g, ''))) return 0.85;
      return 0;
    },
  },
  {
    sourceType: 'social_profile', targetType: 'person',
    label: 'profile_of',
    match: (src, tgt) => {
      const srcName = (src.properties.displayName || src.label).toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (srcName && tgtName && (srcName.includes(tgtName) || tgtName.includes(srcName))) return 0.8;
      const email = (src.properties.email || '').toLowerCase();
      const personEmail = (tgt.properties.email || '').toLowerCase();
      if (email && personEmail && email === personEmail) return 1.0;
      return 0;
    },
  },
  {
    sourceType: 'vehicle', targetType: 'person',
    label: 'owned_by',
    match: (src, tgt) => {
      const owner = (src.properties.owner || '').toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (owner && tgtName && owner.includes(tgtName)) return 0.9;
      return 0;
    },
  },
  {
    sourceType: 'mac_address', targetType: 'wifi_network',
    label: 'connected_to',
    match: (src, tgt) => {
      const srcNetworks: string[] = src.properties.wifiNetworks || [];
      if (srcNetworks.includes(tgt.properties.ssid || tgt.label)) return 0.95;
      return 0;
    },
  },
  {
    sourceType: 'mac_address', targetType: 'person',
    label: 'device_of',
    match: (src, tgt) => {
      const owner = (src.properties.owner || '').toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (owner && tgtName && owner.includes(tgtName)) return 0.85;
      return 0;
    },
  },
  {
    sourceType: 'place', targetType: 'person',
    label: 'residence_of',
    match: (src, tgt) => {
      const residents: string[] = src.properties.residents || [];
      const tgtName = (tgt.label || '').toLowerCase();
      if (residents.some(r => r.toLowerCase().includes(tgtName))) return 0.9;
      return 0;
    },
  },
  {
    sourceType: 'personal_id', targetType: 'person',
    label: 'identifies',
    match: (src, tgt) => {
      const nameOnID = (src.properties.fullName || '').toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (nameOnID && tgtName && nameOnID.includes(tgtName)) return 0.95;
      return 0;
    },
  },
  {
    sourceType: 'event', targetType: 'place',
    label: 'occurred_at',
    match: (src, tgt) => {
      if (!src.coordinates || !tgt.coordinates) return 0;
      const d = haversineKm(src.coordinates.lat, src.coordinates.lng, tgt.coordinates.lat, tgt.coordinates.lng);
      return d < 1 ? 0.95 : d < 10 ? 0.7 : d < 50 ? 0.4 : 0;
    },
  },
  {
    sourceType: 'event', targetType: 'person',
    label: 'involved',
    match: (src, tgt) => {
      const participants: string[] = src.properties.participants || [];
      const tgtName = (tgt.label || '').toLowerCase();
      if (participants.some(p => p.toLowerCase().includes(tgtName))) return 0.9;
      return 0;
    },
  },
];

// ── Cross-Platform Identity Resolution Rules ──
// Same email/phone, fuzzy name match, profile-person, ID-person.
const IDENTITY_RESOLUTION_RULES: {
  label: string;
  match: (src: PersonalEntity, tgt: PersonalEntity) => number;
}[] = [
  { label: 'same_as', match: (a, b) => {
    const aPhone = (a.properties.phone || a.properties.number || '').replace(/[^0-9+]/g, '');
    const bPhone = (b.properties.phone || b.properties.number || '').replace(/[^0-9+]/g, '');
    if (aPhone && bPhone && aPhone === bPhone && aPhone.length >= 8) return 1.0;
    if (aPhone && bPhone && aPhone.slice(-8) === bPhone.slice(-8)) return 0.9;
    const aEmail = (a.properties.email || '').toLowerCase().trim();
    const bEmail = (b.properties.email || '').toLowerCase().trim();
    if (aEmail && bEmail && aEmail === bEmail) return 1.0;
    return 0;
  }},
  { label: 'same_as', match: (a, b) => {
    if (a.type !== 'person' || b.type !== 'person') return 0;
    if (a.id === b.id) return 0;
    // Fuzzy name match (simple)
    const aName = (a.label || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const bName = (b.label || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (!aName || !bName) return 0;
    if (aName === bName) return 1.0;
    if (aName.includes(bName) || bName.includes(aName)) return 0.9;
    return 0;
  }},
  { label: 'same_as', match: (a, b) => {
    if (a.type === 'social_profile' && b.type === 'person') {
      const displayName = (a.properties.displayName || a.label || '').toLowerCase().trim();
      const personName = (b.label || '').toLowerCase().trim();
      if (displayName.includes(personName) || personName.includes(displayName)) return 0.85;
    }
    if (a.type === 'person' && b.type === 'social_profile') {
      const displayName = (b.properties.displayName || b.label || '').toLowerCase().trim();
      const personName = (a.label || '').toLowerCase().trim();
      if (displayName.includes(personName) || personName.includes(displayName)) return 0.85;
    }
    return 0;
  }},
  { label: 'same_as', match: (a, b) => {
    const [idEntity, personEntity] = a.type === 'personal_id' ? [a, b] : b.type === 'personal_id' ? [b, a] : [null, null];
    if (!idEntity || !personEntity || personEntity.type !== 'person') return 0;
    const idName = (idEntity.properties.fullName || '').toLowerCase();
    const personName = (personEntity.label || '').toLowerCase();
    if (idName.includes(personName) || personName.includes(idName)) return 0.85;
    return 0;
  }},
  { label: 'same_as', match: (a, b) => {
    const aPhoto = a.properties.photo_url || a.properties.photo || '';
    const bPhoto = b.properties.photo_url || b.properties.photo || '';
    if (aPhoto && bPhoto && aPhoto === bPhoto) return 0.95;
    return 0;
  }},
  { label: 'same_as', match: (a, b) => {
    const aTz = a.properties.timezone || '';
    const bTz = b.properties.timezone || '';
    const aLang = a.properties.language || '';
    const bLang = b.properties.language || '';
    let s = 0;
    if (aTz && bTz && aTz === bTz) s += 0.4;
    if (aLang && bLang && aLang === bLang) s += 0.3;
    if (a.coordinates && b.coordinates) {
      const d = haversineKm(a.coordinates.lat, a.coordinates.lng, b.coordinates.lat, b.coordinates.lng);
      if (d < 10) s += 0.3; else if (d < 50) s += 0.15;
    }
    return Math.min(s, 0.95);
  }},
];

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Cross-Platform Identity Resolution: Merge Candidates ──

export interface MergeCandidate {
  primaryEntity: PersonalEntity;
  duplicateEntity: PersonalEntity;
  sameAsRelationship: PersonalRelationship;
  sharedSignals: string[];   // e.g. ['same_email', 'same_phone', 'fuzzy_name_match', 'profile_name_match']
  aggregateConfidence: number;
}

/**
 * Find all entities linked by 'same_as' relationships and return them
 * as merge candidates for the admin review queue.
 */
export async function findMergeCandidates(): Promise<MergeCandidate[]> {
  await ensureStore();

  if (!isDBAvailable()) {
    // In-memory mode
    const sameAsRels = memStore.relationships.filter(r => r.label === 'same_as');
    const candidates: MergeCandidate[] = [];
    for (const rel of sameAsRels) {
      const src = memStore.entities.find(e => e.id === rel.sourceId);
      const tgt = memStore.entities.find(e => e.id === rel.targetId);
      if (!src || !tgt) continue;
      const signals = extractIdentitySignals(src, tgt, rel);
      const alreadyAdded = candidates.some(c =>
        (c.primaryEntity.id === src.id && c.duplicateEntity.id === tgt.id) ||
        (c.primaryEntity.id === tgt.id && c.duplicateEntity.id === src.id)
      );
      if (alreadyAdded) continue;
      candidates.push({
        primaryEntity: src,
        duplicateEntity: tgt,
        sameAsRelationship: rel,
        sharedSignals: signals,
        aggregateConfidence: rel.strength + signals.length * 0.02,
      });
    }
    return candidates.sort((a, b) => b.aggregateConfidence - a.aggregateConfidence);
  }

  // Postgres mode
  try {
    const relsResult = await query(
      `SELECT r.*, se.*, te.*
       FROM ontology_relationships r
       JOIN ontology_entities se ON r.source_id = se.id
       JOIN ontology_entities te ON r.target_id = te.id
       WHERE r.label = 'same_as'`
    );
    const candidates: MergeCandidate[] = [];
    const seen = new Set<string>();
    if (relsResult?.rows) {
      for (const row of relsResult.rows) {
        const src = rowToEntity(row);
        const tgt = rowToEntity({ ...row, id: row.target_id, type: row.target_type, /* ... */ });
        // Simplified - full impl would need proper column mapping
        const key = [src.id, tgt.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          primaryEntity: src,
          duplicateEntity: tgt,
          sameAsRelationship: {
            id: row.id,
            sourceId: row.source_id,
            targetId: row.target_id,
            label: 'same_as',
            strength: row.strength || 0.8,
            createdAt: row.created_at || new Date().toISOString(),
          },
          sharedSignals: ['auto_detected'],
          aggregateConfidence: row.strength || 0.8,
        });
      }
    }
    return candidates.sort((a, b) => b.aggregateConfidence - a.aggregateConfidence);
  } catch {
    return [];
  }
}

/**
 * Merge two entities: keeps the primary entity and transfers all properties,
 * relationships, and tags from the duplicate into it, then deletes the duplicate.
 */
export async function mergeEntities(
  primaryId: string,
  duplicateId: string
): Promise<{ success: boolean; mergedEntity: PersonalEntity | null }> {
  await ensureStore();
  const primary = await getEntity(primaryId);
  const duplicate = await getEntity(duplicateId);
  if (!primary || !duplicate) return { success: false, mergedEntity: null };

  // Merge properties (duplicate wins on conflict)
  const mergedProperties = { ...duplicate.properties, ...primary.properties };
  // Merge tags
  const mergedTags = [...new Set([...primary.tags, ...duplicate.tags])];
  // Pick longer description
  const mergedDescription = [primary.description, duplicate.description]
    .filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0))[0] || '';

  const merged: PersonalEntity = {
    ...primary,
    description: mergedDescription,
    properties: mergedProperties,
    tags: mergedTags,
    linkedEntityIds: [
      ...new Set([
        ...(primary.linkedEntityIds || []),
        ...(duplicate.linkedEntityIds || []),
      ]),
    ],
  };

  // Update primary
  const updated = await upsertEntity(merged);

  // Re-point all relationships from duplicate to primary
  if (!isDBAvailable()) {
    for (const rel of memStore.relationships) {
      if (rel.sourceId === duplicateId) rel.sourceId = primaryId;
      if (rel.targetId === duplicateId) rel.targetId = primaryId;
    }
    // Remove duplicate
    memStore.entities = memStore.entities.filter(e => e.id !== duplicateId);
    // Remove self-referencing same_as
    memStore.relationships = memStore.relationships.filter(
      r => !(r.label === 'same_as' &&
        ((r.sourceId === primaryId && r.targetId === primaryId) ||
         (r.sourceId === duplicateId || r.targetId === duplicateId)))
    );
  } else {
    // Postgres: cascade relationships
    await query('UPDATE ontology_relationships SET source_id = $1 WHERE source_id = $2', [primaryId, duplicateId]);
    await query('UPDATE ontology_relationships SET target_id = $1 WHERE target_id = $2', [primaryId, duplicateId]);
    await query('DELETE FROM ontology_entities WHERE id = $1', [duplicateId]);
  }

  return { success: true, mergedEntity: updated };
}

function extractIdentitySignals(
  a: PersonalEntity,
  b: PersonalEntity,
  rel: PersonalRelationship
): string[] {
  const signals: string[] = [];
  const aPhone = (a.properties.phone || a.properties.number || '').replace(/[^0-9+]/g, '');
  const bPhone = (b.properties.phone || b.properties.number || '').replace(/[^0-9+]/g, '');
  const aEmail = (a.properties.email || '').toLowerCase();
  const bEmail = (b.properties.email || '').toLowerCase();

  if (aPhone && bPhone && aPhone === bPhone) signals.push('same_phone');
  if (aEmail && bEmail && aEmail === bEmail) signals.push('same_email');
  if (a.type === 'person' && b.type === 'person') {
    const aName = (a.label || '').toLowerCase();
    const bName = (b.label || '').toLowerCase();
    if (aName.includes(bName) || bName.includes(aName)) signals.push('fuzzy_name_match');
    const aAliases = (a.properties.aliases || []) as string[];
    const bAliases = (b.properties.aliases || []) as string[];
    for (const aa of aAliases) {
      if (bAliases.some((ba: string) => ba.toLowerCase() === aa.toLowerCase())) {
        signals.push('alias_overlap');
        break;
      }
    }
  }
  if ((a.type === 'social_profile' || b.type === 'social_profile') &&
      (a.type === 'person' || b.type === 'person')) {
    signals.push('profile_person_link');
  }
  // Photo similarity
  const aPhoto = (a.properties.photo_url || a.properties.photo || '') as string;
  const bPhoto = (b.properties.photo_url || b.properties.photo || '') as string;
  if (aPhoto && bPhoto && aPhoto === bPhoto) signals.push('photo_similarity');
  // Behavioural fingerprint
  const aTz = (a.properties.timezone || '') as string;
  const bTz = (b.properties.timezone || '') as string;
  const aLang = (a.properties.language || '') as string;
  const bLang = (b.properties.language || '') as string;
  if (aTz && bTz && aTz === bTz) signals.push('behavioural_fingerprint');
  if (aLang && bLang && aLang === bLang) signals.push('behavioural_fingerprint');
  return signals;
}
