-- ═══════════════════════════════════════════════════════════════
--  10 — Ontology Core (relational source of truth)
--
--  Design: relational tables are the CANONICAL store for object
--  instances, links, provenance and the vector index. The AGE graph
--  (see 20_graph.sql) is a TRAVERSAL/ANALYTICS mirror kept in sync by
--  the app layer in Phase 1. This gives you fast property/full-text
--  queries AND graph algorithms without choosing one or the other.
-- ═══════════════════════════════════════════════════════════════

-- ── Type registry: populated from /ontology/*.yaml at boot ──────
-- Lets you add new object/link types as DATA, not code.
CREATE TABLE ontology.object_types (
    name         TEXT PRIMARY KEY,           -- e.g. 'person', 'vessel'
    domain       TEXT NOT NULL,              -- e.g. 'PERSON', 'SEA'
    display_name TEXT NOT NULL,
    icon         TEXT,
    color        TEXT,
    schema       JSONB NOT NULL DEFAULT '{}',-- property definitions
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ontology.link_types (
    name         TEXT PRIMARY KEY,           -- e.g. 'owns', 'communicated_with'
    display_name TEXT NOT NULL,
    directed     BOOLEAN NOT NULL DEFAULT true,
    source_types TEXT[] NOT NULL DEFAULT '{}',-- allowed object_types on source side
    target_types TEXT[] NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Provenance: every raw thing ever ingested ──────────────────
CREATE TABLE ontology.ingest_sources (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         TEXT NOT NULL,              -- file | image | audio | url | feed | manual
    uri          TEXT,                       -- minio://bucket/key or https://...
    sha256       TEXT,                       -- dedup raw blobs
    mime         TEXT,
    bytes        BIGINT,
    ingested_by  TEXT,                       -- user / agent id
    metadata     JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_sources_sha ON ontology.ingest_sources(sha256) WHERE sha256 IS NOT NULL;

-- ── Object instances (the "objects" of the ontology) ───────────
CREATE TABLE ontology.entities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_type TEXT NOT NULL REFERENCES ontology.object_types(name),
    title       TEXT NOT NULL,
    properties  JSONB NOT NULL DEFAULT '{}',
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    occurred_at TIMESTAMPTZ,                 -- event/temporal anchor if any
    confidence  REAL NOT NULL DEFAULT 1.0,   -- 0..1
    source_id   UUID REFERENCES ontology.ingest_sources(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Links (the "links" of the ontology) ────────────────────────
CREATE TABLE ontology.relationships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_type   TEXT NOT NULL REFERENCES ontology.link_types(name),
    source_id   UUID NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
    target_id   UUID NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
    strength    REAL NOT NULL DEFAULT 1.0,   -- 0..1 confidence
    properties  JSONB NOT NULL DEFAULT '{}',
    source_ref  UUID REFERENCES ontology.ingest_sources(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (link_type, source_id, target_id)
);

-- ── Unstructured chunks + embeddings (semantic search) ─────────
-- 768 dims = nomic-embed-text (Ollama). Change to 1024 for bge-m3.
CREATE TABLE ontology.chunks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id   UUID NOT NULL REFERENCES ontology.ingest_sources(id) ON DELETE CASCADE,
    entity_id   UUID REFERENCES ontology.entities(id) ON DELETE SET NULL,
    seq         INT NOT NULL DEFAULT 0,
    text        TEXT NOT NULL,
    embedding   vector(768),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Investigations / Cases (Gotham primitive) ──────────────────
CREATE TABLE ontology.cases (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    summary     TEXT,
    status      TEXT NOT NULL DEFAULT 'open', -- open | active | closed
    entity_ids  UUID[] NOT NULL DEFAULT '{}',
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Immutable audit log (governance — never UPDATE/DELETE) ──────
CREATE TABLE ontology.audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor       TEXT NOT NULL,              -- user / agent id
    action      TEXT NOT NULL,             -- read | create | update | merge | link | flag | export
    object_type TEXT,
    object_id   TEXT,                          -- TEXT: app entity ids aren't all UUIDs
    detail      JSONB NOT NULL DEFAULT '{}',
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- keep updated_at honest
CREATE OR REPLACE FUNCTION ontology.touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entities_touch BEFORE UPDATE ON ontology.entities
    FOR EACH ROW EXECUTE FUNCTION ontology.touch_updated_at();
CREATE TRIGGER trg_cases_touch BEFORE UPDATE ON ontology.cases
    FOR EACH ROW EXECUTE FUNCTION ontology.touch_updated_at();
