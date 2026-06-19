/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — GraphRAG: Multi-hop Graph Traversal Engine
 *
 *  Translates query plans into multi-hop traversals over the
 *  ontology graph — walking entity → relationship → entity edges,
 *  filtering by type, property, stance, and relationship label,
 *  then ranking results by relevance and evidence strength.
 *
 *  Pure in-memory traversal (no external DB or AI needed for
 *  the retrieval step — AI is used only for answer synthesis).
 * ═══════════════════════════════════════════════════════════════
 */

import { PersonalEntity, PersonalRelationship, PersonalDomain } from '../personal-ontology';
import { getEntities, getRelationships, expandEntity, getEntity } from '../store/entity-store';

// ──────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────

export interface GraphEntity {
  id: string;
  type: string;
  label: string;
  domain: string;
  properties: Record<string, any>;
  tags: string[];
  source: string;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  label: string;
  strength: number;
  metadata?: Record<string, any>;
}

export interface TraversalHop {
  /** Entity IDs matched at this hop */
  entities: GraphEntity[];
  /** Edges traversed to reach this hop */
  edges: GraphEdge[];
  /** How this hop connects to the previous one */
  viaRelationship?: string;
}

export interface TraversalPath {
  /** Full entity path: seed → hop1 → hop2 → ... → result */
  entities: GraphEntity[];
  /** Edges connecting the path */
  edges: GraphEdge[];
  /** Stance filters applied (for explanation) */
  stanceFilters?: { target: string; sentiment: string; score: number }[];
  /** Relevance score for ranking */
  relevanceScore: number;
  /** Human-readable explanation of this path */
  explanation: string;
}

export interface TraversalResult {
  /** All result entities (deduplicated) */
  results: GraphEntity[];
  /** Full paths from seed to results */
  paths: TraversalPath[];
  /** Total paths found */
  totalPaths: number;
  /** Query execution stats */
  stats: {
    entitiesScanned: number;
    edgesTraversed: number;
    hops: number;
    durationMs: number;
  };
}

// ── Query Plan (output of question parser, input to traversal) ──

export interface QueryPlan {
  /** Seed entity type to start from */
  seedType?: string;
  /** Seed entity search terms */
  seedSearch?: string;
  /** Seed entity IDs (if known) */
  seedIds?: string[];
  /** Seed entity tags to filter by */
  seedTags?: string[];
  /** Hops: ordered list of relationship traversals */
  hops: QueryHop[];
  /** Target entity type to return */
  targetType?: string;
  /** Stance filter: filter result entities by stance toward a target */
  stanceFilter?: {
    target: string;
    sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
    minConfidence?: number;
    minEvidence?: number;
  };
  /** Maximum results */
  maxResults: number;
  /** Whether to include intermediate hop entities in output */
  includeIntermediate: boolean;
}

export interface QueryHop {
  /** Relationship label(s) to traverse */
  relationship: string | string[];
  /** Direction: forward (source→target), reverse (target→source), or both */
  direction: 'forward' | 'reverse' | 'both';
  /** Filter target entities by type after this hop */
  targetType?: string;
  /** Filter target entities by tag after this hop */
  targetTag?: string;
  /** Minimum relationship strength */
  minStrength?: number;
  /** Name/label for this hop (for answer synthesis) */
  label?: string;
}

// ──────────────────────────────────────────────────────────────
//  CORE TRAVERSAL FUNCTIONS
// ──────────────────────────────────────────────────────────────

/**
 * Convert a PersonalEntity to our GraphEntity shape.
 */
function toGraphEntity(e: PersonalEntity): GraphEntity {
  return {
    id: e.id,
    type: e.type,
    label: e.label,
    domain: e.domain,
    properties: e.properties || {},
    tags: e.tags || [],
    source: e.source || '',
  };
}

function toGraphEdge(r: PersonalRelationship): GraphEdge {
  return {
    sourceId: r.sourceId,
    targetId: r.targetId,
    label: r.label,
    strength: r.strength,
    metadata: r.metadata,
  };
}

/**
 * Find entities matching search criteria.
 */
async function findEntities(options: {
  type?: string;
  search?: string;
  tags?: string[];
  limit?: number;
}): Promise<GraphEntity[]> {
  const result = await getEntities({
    type: options.type,
    search: options.search,
    limit: options.limit || 500,
  });
  let entities = result.entities.map(toGraphEntity);

  if (options.tags && options.tags.length > 0) {
    entities = entities.filter(e =>
      options.tags!.some(t => e.tags.includes(t)),
    );
  }

  return entities;
}

/**
 * Get all edges (relationships) for a set of entity IDs.
 */
async function findEdges(
  entityIds: Set<string>,
  relationshipLabel?: string,
  minStrength?: number,
): Promise<Map<string, GraphEdge[]>> {
  const allRelationships = await getRelationships();
  const edgesByEntity = new Map<string, GraphEdge[]>();

  for (const rel of allRelationships) {
    if (minStrength !== undefined && rel.strength < minStrength) continue;
    if (relationshipLabel && rel.label !== relationshipLabel) continue;

    const edge = toGraphEdge(rel);

    // Index by source
    if (entityIds.has(edge.sourceId)) {
      if (!edgesByEntity.has(edge.sourceId)) edgesByEntity.set(edge.sourceId, []);
      edgesByEntity.get(edge.sourceId)!.push(edge);
    }
    // Index by target
    if (entityIds.has(edge.targetId)) {
      if (!edgesByEntity.has(edge.targetId)) edgesByEntity.set(edge.targetId, []);
      edgesByEntity.get(edge.targetId)!.push(edge);
    }
  }

  return edgesByEntity;
}

/**
 * Follow edges from a set of entity IDs through a relationship hop.
 * Returns the set of connected entity IDs (on the other side of the edge).
 */
function followEdges(
  edgesByEntity: Map<string, GraphEdge[]>,
  currentIds: Set<string>,
  hop: QueryHop,
): { connectedIds: Set<string>; traversedEdges: GraphEdge[] } {
  const connectedIds = new Set<string>();
  const traversedEdges: GraphEdge[] = [];
  const relLabels = Array.isArray(hop.relationship) ? hop.relationship : [hop.relationship];

  for (const id of currentIds) {
    const edges = edgesByEntity.get(id) || [];
    for (const edge of edges) {
      if (!relLabels.includes(edge.label)) continue;
      if (hop.minStrength !== undefined && edge.strength < hop.minStrength) continue;

      let otherId: string | null = null;
      if (hop.direction === 'forward' && edge.sourceId === id) {
        otherId = edge.targetId;
      } else if (hop.direction === 'reverse' && edge.targetId === id) {
        otherId = edge.sourceId;
      } else if (hop.direction === 'both') {
        otherId = edge.sourceId === id ? edge.targetId : edge.sourceId;
      }

      if (otherId && !currentIds.has(otherId)) {
        connectedIds.add(otherId);
        traversedEdges.push(edge);
      }
    }
  }

  return { connectedIds, traversedEdges };
}

/**
 * Get entity objects by IDs from the store.
 */
async function resolveEntities(ids: Set<string>): Promise<GraphEntity[]> {
  const entities: GraphEntity[] = [];
  for (const id of ids) {
    const entity = await getEntity(id);
    if (entity) {
      entities.push(toGraphEntity(entity));
    }
  }
  return entities;
}

// ──────────────────────────────────────────────────────────────
//  STANCE FILTERING
// ──────────────────────────────────────────────────────────────

/**
 * Filter entities by their stance toward a target.
 * Reads from the entity's stance_profiles property.
 */
function filterByStance(
  entities: GraphEntity[],
  target: string,
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed',
  minConfidence: number = 0.2,
  minEvidence: number = 1,
): GraphEntity[] {
  return entities.filter(e => {
    const profiles = e.properties?.stance_profiles;
    if (!profiles) return false;

    const targetLower = target.toLowerCase();
    const profile = profiles[targetLower];
    if (!profile) return false;
    if (profile.confidence < minConfidence) return false;
    if ((profile.count?.total || 0) < minEvidence) return false;

    if (sentiment === 'positive' && profile.sentimentLabel === 'positive') return true;
    if (sentiment === 'negative' && profile.sentimentLabel === 'negative') return true;
    if (sentiment === 'neutral' && (profile.sentimentLabel === 'neutral' || profile.sentimentLabel === 'mixed')) return true;
    if (sentiment === 'mixed' && profile.sentimentLabel === 'mixed') return true;

    return false;
  });
}

// ──────────────────────────────────────────────────────────────
//  RANKING
// ──────────────────────────────────────────────────────────────

interface RankOptions {
  /** Boost exact matches */
  labelMatch?: string;
  /** Boost recent entities */
  preferRecent?: boolean;
  /** Boost entities with stance data */
  preferStance?: boolean;
  /** Boost entities with more edges */
  preferConnected?: boolean;
}

function rankResults(
  entities: GraphEntity[],
  paths: TraversalPath[],
  options: RankOptions = {},
): { entity: GraphEntity; score: number; path: TraversalPath }[] {
  const scored = entities.map(entity => {
    const path = paths.find(p => p.entities[p.entities.length - 1]?.id === entity.id) || paths[0];
    let score = path.relevanceScore;

    // Label match boost
    if (options.labelMatch && entity.label.toLowerCase().includes(options.labelMatch.toLowerCase())) {
      score *= 1.3;
    }

    // Stance data boost
    if (options.preferStance && entity.properties?.stance_profiles) {
      const profileCount = Object.keys(entity.properties.stance_profiles).length;
      score *= 1 + profileCount * 0.05;
    }

    // Recent boost
    if (options.preferRecent && entity.properties?.nlp_enriched_at) {
      // Small boost for enriched entities
      score *= 1.1;
    }

    return { entity, score: Math.round(score * 100) / 100, path };
  });

  return scored.sort((a, b) => b.score - a.score);
}

// ──────────────────────────────────────────────────────────────
//  MAIN TRAVERSAL EXECUTOR
// ──────────────────────────────────────────────────────────────

/**
 * Execute a multi-hop graph traversal according to a query plan.
 * Walks entity → relationship → entity across multiple hops,
 * applying filters at each step.
 */
export async function executeGraphQuery(plan: QueryPlan): Promise<TraversalResult> {
  const startTime = Date.now();
  let entitiesScanned = 0;
  let edgesTraversed = 0;

  // ── Step 1: Find seed entities ──
  let seedEntities: GraphEntity[] = [];

  if (plan.seedIds && plan.seedIds.length > 0) {
    for (const id of plan.seedIds) {
      const entity = await getEntity(id);
      if (entity) {
        seedEntities.push(toGraphEntity(entity));
        entitiesScanned++;
      }
    }
  }

  if (seedEntities.length === 0 && plan.seedSearch) {
    seedEntities = await findEntities({
      type: plan.seedType,
      search: plan.seedSearch,
      tags: plan.seedTags,
    });
    entitiesScanned += seedEntities.length;
  }

  if (seedEntities.length === 0 && plan.seedType && !plan.seedSearch) {
    seedEntities = await findEntities({
      type: plan.seedType,
      tags: plan.seedTags,
    });
    entitiesScanned += seedEntities.length;
  }

  if (seedEntities.length === 0) {
    return {
      results: [],
      paths: [],
      totalPaths: 0,
      stats: { entitiesScanned, edgesTraversed, hops: 0, durationMs: Date.now() - startTime },
    };
  }

  // ── Step 2: Execute hops ──
  let currentIds = new Set(seedEntities.map(e => e.id));
  const allPaths: TraversalPath[] = [];
  const allEdges: GraphEdge[] = [];

  // Create initial paths for seed entities
  for (const entity of seedEntities) {
    allPaths.push({
      entities: [entity],
      edges: [],
      relevanceScore: 1.0,
      explanation: `Seed: ${entity.label}`,
    });
  }

  for (let hopIndex = 0; hopIndex < plan.hops.length; hopIndex++) {
    const hop = plan.hops[hopIndex];

    // Get all edges connecting current entities
    const edgesByEntity = await findEdges(currentIds, undefined, hop.minStrength);
    edgesTraversed += [...edgesByEntity.values()].reduce((s, e) => s + e.length, 0);

    // Follow edges through this hop
    const { connectedIds, traversedEdges } = followEdges(edgesByEntity, currentIds, hop);
    allEdges.push(...traversedEdges);

    // Resolve connected entities
    let connectedEntities = await resolveEntities(connectedIds);
    entitiesScanned += connectedEntities.length;

    // Filter by target type if specified
    if (hop.targetType) {
      connectedEntities = connectedEntities.filter(e => e.type === hop.targetType);
    }

    // Filter by target tag if specified
    if (hop.targetTag) {
      const targetTag = hop.targetTag;
      connectedEntities = connectedEntities.filter(e =>
        e.tags.some(t => t.includes(targetTag)),
      );
    }

    // Build new paths extending from existing ones
    if (connectedEntities.length > 0) {
      const newPaths: TraversalPath[] = [];

      for (const existingPath of allPaths) {
        const lastEntity = existingPath.entities[existingPath.entities.length - 1];

        // Find edges from lastEntity to each connected entity
        for (const connEntity of connectedEntities) {
          const connectingEdges = traversedEdges.filter(
            e =>
              (e.sourceId === lastEntity.id && e.targetId === connEntity.id) ||
              (e.targetId === lastEntity.id && e.sourceId === connEntity.id),
          );

          if (connectingEdges.length === 0) continue;

          const hopLabel = hop.label || hop.relationship;
          const strength = connectingEdges.reduce((s, e) => s + e.strength, 0) / connectingEdges.length;

          newPaths.push({
            entities: [...existingPath.entities, connEntity],
            edges: [...existingPath.edges, ...connectingEdges],
            relevanceScore: existingPath.relevanceScore * strength,
            explanation: `${existingPath.explanation} → [${hopLabel}] ${connEntity.label}`,
          });
        }
      }

      if (newPaths.length > 0) {
        allPaths.length = 0;
        allPaths.push(...newPaths);
      }
    }

    currentIds = new Set(connectedEntities.map(e => e.id));

    // If no entities found at this hop, stop early
    if (currentIds.size === 0) break;
  }

  // ── Step 3: Apply target type filter ──
  let resultEntities = allPaths.map(p => p.entities[p.entities.length - 1]);
  if (plan.targetType) {
    resultEntities = resultEntities.filter(e => e.type === plan.targetType);
  }

  // ── Step 4: Apply stance filter ──
  let stanceExplain: { target: string; sentiment: string; score: number }[] = [];
  if (plan.stanceFilter) {
    const { target, sentiment, minConfidence, minEvidence } = plan.stanceFilter;
    const beforeCount = resultEntities.length;
    resultEntities = filterByStance(resultEntities, target, sentiment, minConfidence, minEvidence);
    const afterCount = resultEntities.length;

    // Add stance explanation to paths
    for (const path of allPaths) {
      const lastEntity = path.entities[path.entities.length - 1];
      const profile = lastEntity?.properties?.stance_profiles?.[target.toLowerCase()];
      if (profile) {
        stanceExplain.push({
          target: profile.target || target,
          sentiment: profile.sentimentLabel,
          score: profile.score,
        });
        path.stanceFilters = stanceExplain;
        path.relevanceScore *= Math.abs(profile.score) * profile.confidence;
        path.explanation += ` | stance toward ${target}: ${profile.sentimentLabel} (${profile.score})`;
      }
    }
  }

  // ── Step 5: Deduplicate ──
  const seenIds = new Set<string>();
  const uniqueResults: GraphEntity[] = [];
  const uniquePaths: TraversalPath[] = [];

  for (let i = 0; i < resultEntities.length; i++) {
    const entity = resultEntities[i];
    const path = allPaths[i];
    if (!seenIds.has(entity.id)) {
      seenIds.add(entity.id);
      uniqueResults.push(entity);
      uniquePaths.push(path);
    }
  }

  // ── Step 6: Rank ──
  const ranked = rankResults(uniqueResults, uniquePaths, {
    preferConnected: true,
  });

  const finalResults = ranked.slice(0, plan.maxResults).map(r => r.entity);
  const finalPaths = ranked.slice(0, plan.maxResults).map(r => r.path);

  return {
    results: finalResults,
    paths: finalPaths,
    totalPaths: finalPaths.length,
    stats: {
      entitiesScanned,
      edgesTraversed,
      hops: plan.hops.length,
      durationMs: Date.now() - startTime,
    },
  };
}

// ──────────────────────────────────────────────────────────────
//  CONVENIENCE QUERIES
// ──────────────────────────────────────────────────────────────

/**
 * Quick query: find entities with a specific relationship to a seed entity.
 */
export async function findRelatedEntities(
  seedId: string,
  relationship: string,
  direction: 'forward' | 'reverse' | 'both' = 'forward',
): Promise<{ entities: GraphEntity[]; edges: GraphEdge[] }> {
  const plan: QueryPlan = {
    seedIds: [seedId],
    hops: [{ relationship, direction }],
    maxResults: 100,
    includeIntermediate: false,
  };

  const result = await executeGraphQuery(plan);
  return {
    entities: result.results,
    edges: result.paths.flatMap(p => p.edges),
  };
}

/**
 * Find entities with a specific stance toward a target.
 */
export async function findEntitiesByStance(
  stanceTarget: string,
  sentiment: 'positive' | 'negative',
  entityType?: string,
  maxResults: number = 50,
): Promise<GraphEntity[]> {
  const plan: QueryPlan = {
    seedType: entityType,
    hops: [],
    stanceFilter: { target: stanceTarget, sentiment, minConfidence: 0.2, minEvidence: 1 },
    maxResults,
    includeIntermediate: false,
  };

  const result = await executeGraphQuery(plan);
  return result.results;
}
