/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — useOntologyTypes hook
 *
 *  Client-side accessor for the declarative ontology registry served
 *  by GET /api/ontology/types (which reads osiris-foundation/ontology
 *  /*.yaml). Lets the UI render object/link type pickers driven by the
 *  foundation YAML instead of hardcoded type lists — add a type in
 *  YAML and it appears in the UI with no code change.
 *
 *  The result is cached at module scope so the registry is fetched
 *  once per session and shared across every consumer.
 * ═══════════════════════════════════════════════════════════════
 */

'use client';

import { useEffect, useState } from 'react';

export interface OntologyPropertyDef {
  type: string;
  label: string;
  required: boolean;
  searchable: boolean;
  pii: boolean;
  embed: boolean;
  enum?: string[];
  description?: string;
}

export interface OntologyObjectType {
  type: string;
  domain: string;
  label: string;
  description: string;
  icon: string;
  color: string;
  properties: Record<string, OntologyPropertyDef>;
}

export interface OntologyLinkType {
  type: string;
  label: string;
  description: string;
  directed: boolean;
  sourceTypes: string[];
  targetTypes: string[];
  strength: number;
}

export interface OntologyTypes {
  objectTypes: OntologyObjectType[];
  linkTypes: OntologyLinkType[];
}

// Module-scope cache + in-flight de-duplication.
let cache: OntologyTypes | null = null;
let inflight: Promise<OntologyTypes> | null = null;

async function fetchOntologyTypes(): Promise<OntologyTypes> {
  if (cache) return cache;
  if (!inflight) {
    inflight = fetch('/api/ontology/types')
      .then(r => r.json())
      .then((data: OntologyTypes) => {
        cache = {
          objectTypes: data.objectTypes || [],
          linkTypes: data.linkTypes || [],
        };
        return cache;
      })
      .catch(() => ({ objectTypes: [], linkTypes: [] }))
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * React hook returning the ontology type registry.
 * `loading` is true until the first fetch resolves.
 */
export function useOntologyTypes(): OntologyTypes & { loading: boolean } {
  const [types, setTypes] = useState<OntologyTypes>(cache || { objectTypes: [], linkTypes: [] });
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    let active = true;
    // A warm cache resolves synchronously inside fetchOntologyTypes (it returns
    // the cached value), so a cache hit just settles on the next microtask —
    // no synchronous setState in the effect body, and the initial render
    // already shows the cache when present.
    fetchOntologyTypes().then(t => {
      if (active) { setTypes(t); setLoading(false); }
    });
    return () => { active = false; };
  }, []);

  return { ...types, loading };
}
