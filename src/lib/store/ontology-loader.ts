/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Ontology Registry Loader (Foundry / Phase 1)
 *
 *  Reads the declarative ontology in `osiris-foundation/ontology/*.yaml`
 *  and upserts it into the canonical type-registry tables defined by
 *  `osiris-foundation/db/init/10_ontology_schema.sql`:
 *
 *      ontology.object_types   (name, domain, display_name, icon, color, schema)
 *      ontology.link_types     (name, display_name, directed, source_types, target_types)
 *
 *  This is the roadmap's Phase-1 step "YAML loader → upserts
 *  object_types / link_types on boot": add a new object/link type by
 *  editing YAML — no code change. The CREATE TABLE statements are
 *  idempotent and column-compatible with the foundation SQL, so this
 *  works both against the full foundation DB image (tables already
 *  exist) and a bare Postgres.
 *
 *  Safe by construction: a no-op when Postgres is unavailable, and
 *  every failure is swallowed so a registry-load problem can never
 *  break entity persistence or the request that triggered it.
 * ═══════════════════════════════════════════════════════════════
 */

import { query, isDBAvailable } from './db';
import { parseOntologyRegistry } from '../ontology/registry';

let loaded = false;

/** Result of a registry load attempt (for logging / diagnostics). */
export interface RegistryLoadResult {
  loaded: boolean;
  objectTypes: number;
  linkTypes: number;
  reason?: string;
}

/**
 * Ensure the canonical `ontology` type-registry schema exists, then
 * upsert every object/link type from the foundation YAML into it.
 *
 * Runs at most once per process (idempotent). Call from store init.
 */
export async function loadOntologyRegistry(force = false): Promise<RegistryLoadResult> {
  if (loaded && !force) return { loaded: false, objectTypes: 0, linkTypes: 0, reason: 'already-loaded' };

  if (!isDBAvailable()) {
    return { loaded: false, objectTypes: 0, linkTypes: 0, reason: 'db-unavailable' };
  }

  try {
    // Canonical schema + registry tables (matches 10_ontology_schema.sql).
    await query('CREATE SCHEMA IF NOT EXISTS ontology');
    await query(`
      CREATE TABLE IF NOT EXISTS ontology.object_types (
        name         TEXT PRIMARY KEY,
        domain       TEXT NOT NULL,
        display_name TEXT NOT NULL,
        icon         TEXT,
        color        TEXT,
        schema       JSONB NOT NULL DEFAULT '{}',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS ontology.link_types (
        name         TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        directed     BOOLEAN NOT NULL DEFAULT true,
        source_types TEXT[] NOT NULL DEFAULT '{}',
        target_types TEXT[] NOT NULL DEFAULT '{}',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { objectTypes, linkTypes } = await parseOntologyRegistry();

    for (const ot of objectTypes) {
      await query(
        `INSERT INTO ontology.object_types (name, domain, display_name, icon, color, schema)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (name) DO UPDATE SET
           domain = EXCLUDED.domain,
           display_name = EXCLUDED.display_name,
           icon = EXCLUDED.icon,
           color = EXCLUDED.color,
           schema = EXCLUDED.schema`,
        [ot.type, ot.domain, ot.label, ot.icon, ot.color, JSON.stringify(ot.properties || {})]
      );
    }

    for (const lt of linkTypes) {
      await query(
        `INSERT INTO ontology.link_types (name, display_name, directed, source_types, target_types)
         VALUES ($1, $2, $3, $4::text[], $5::text[])
         ON CONFLICT (name) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           directed = EXCLUDED.directed,
           source_types = EXCLUDED.source_types,
           target_types = EXCLUDED.target_types`,
        [lt.type, lt.label, lt.directed, lt.sourceTypes, lt.targetTypes]
      );
    }

    loaded = true;
    console.log(`[OntologyLoader] Registry synced → ${objectTypes.length} object types, ${linkTypes.length} link types`);
    return { loaded: true, objectTypes: objectTypes.length, linkTypes: linkTypes.length };
  } catch (err) {
    console.warn('[OntologyLoader] Registry load skipped:', (err as Error).message);
    return { loaded: false, objectTypes: 0, linkTypes: 0, reason: (err as Error).message };
  }
}
