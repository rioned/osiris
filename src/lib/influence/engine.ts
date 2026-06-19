/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Influence & Narrative Analytics Engine
 *
 *  Builds on the graph-analytics layer to detect opinion
 *  communities, score influencers, trace narrative propagation
 *  through follows/shares/comments, and identify bridge
 *  accounts connecting separate audiences.
 *
 *  Zero external dependencies — reuses existing graph-analytics
 *  algorithms and ontology store data.
 * ═══════════════════════════════════════════════════════════════
 */

import {
  detectCommunities,
  computeCentrality,
  findShortestPath,
  analyzeGraph,
  communityColor,
  type AnalyticsGraphInput,
  type GraphAnalyticsResult,
} from '../graph-analytics';
import { getEntities, getRelationships, getEntity } from '../store/entity-store';
import type { PersonalEntity, PersonalRelationship } from '../personal-ontology';

// ──────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────

/** An entity in the influence graph with enriched properties */
export interface InfluenceNode {
  id: string;
  label: string;
  type: string;
  communityIndex: number;
  /** Influence score (0–1) */
  influenceScore: number;
  /** Centrality metrics */
  centrality: {
    degree: number;
    betweenness: number;
    eigenvector: number;
  };
  /** Stance profile summary: target → sentiment */
  stanceSummary: Record<string, { sentiment: string; score: number; confidence: number }>;
  /** Number of followers (incoming follows) */
  followerCount: number;
  /** Number of people they follow (outgoing follows) */
  followingCount: number;
  /** Whether this entity is a bridge between communities */
  isBridge: boolean;
  /** Bridge score (0–1) if isBridge */
  bridgeScore?: number;
  /** Communities bridged */
  bridgedCommunities?: number[];
}

/** An opinion community cluster */
export interface OpinionCommunity {
  index: number;
  size: number;
  /** Dominant stance toward key targets */
  dominantStances: { target: string; avgScore: number; members: number }[];
  /** Top influencers in this community */
  topInfluencers: InfluenceNode[];
  /** Color for visualization */
  color: string;
  /** Key topics shared by this community */
  sharedTopics: string[];
  /** Label derived from dominant stance */
  label: string;
}

/** A narrative trace — how a stance propagates through the graph */
export interface NarrativeTrace {
  /** The stance/topic being traced */
  topic: string;
  /** The originating entity */
  originator: { id: string; label: string };
  /** Propagation path */
  propagationPath: {
    fromId: string;
    toId: string;
    viaRelationship: string;
    timestamp?: string;
    step: number;
  }[];
  /** Total spread reach */
  reachCount: number;
  /** How many hops the narrative travelled */
  maxDepth: number;
  /** Time span of propagation */
  timeSpanMs: number;
}

/** A bridge account connecting otherwise separate communities */
export interface BridgeAccount {
  entity: InfluenceNode;
  /** Communities bridged */
  communitiesBridged: number[];
  /** Bridge strength */
  bridgeStrength: number;
  /** Key relationships that bridge communities */
  bridgingEdges: { targetId: string; targetLabel: string; targetCommunity: number; relationship: string }[];
}

/** Full influence analysis result */
export interface InfluenceAnalysis {
  /** Timestamp */
  analyzedAt: string;
  /** Graph statistics */
  graphStats: {
    totalNodes: number;
    totalEdges: number;
    communityCount: number;
    modularity: number;
  };
  /** Opinion communities */
  communities: OpinionCommunity[];
  /** Top influencers across the whole graph */
  topInfluencers: InfluenceNode[];
  /** Bridge accounts */
  bridges: BridgeAccount[];
  /** Narrative traces for key stances */
  narrativeTraces: NarrativeTrace[];
  /** Raw graph analytics result */
  graphAnalytics: GraphAnalyticsResult;
}

// ──────────────────────────────────────────────────────────────
//  MAIN ANALYSIS ENTRY POINT
// ──────────────────────────────────────────────────────────────

/**
 * Run full influence & narrative analytics over the ontology graph.
 *
 * 1. Loads all entities + relationships from the store
 * 2. Runs community detection (Louvain) on the graph
 * 3. Scores influence (centrality + stance-based)
 * 4. Identifies bridge accounts
 * 5. Traces narrative propagation for key stances
 */
export async function runInfluenceAnalysis(): Promise<InfluenceAnalysis> {
  const startTime = Date.now();

  // Step 1: Load the full graph from the store
  const { entities: allEntities, relationships: allRelationships } = await loadFullGraph();

  // Step 2: Build analytics-compatible graph input
  const graphInput = buildGraphInput(allEntities, allRelationships);

  // Step 3: Run existing graph analytics
  const graphAnalytics = analyzeGraph(graphInput);

  // Step 4: Compute influence scores per node
  const influenceScores = computeInfluenceScores(
    graphInput,
    graphAnalytics,
    allEntities,
    allRelationships,
  );

  // Step 5: Build opinion communities with stance enrichment
  const communities = buildOpinionCommunities(
    graphAnalytics,
    allEntities,
    influenceScores,
  );

  // Step 6: Identify bridge accounts
  const bridges = detectBridgeAccounts(
    graphInput,
    graphAnalytics,
    allEntities,
    influenceScores,
  );

  // Step 7: Trace narrative propagation for key stances
  const narrativeTraces = await traceNarratives(
    graphInput,
    graphAnalytics,
    allEntities,
    allRelationships,
  );

  // Step 8: Build full node list
  const allNodes = graphInput.nodes.map(n => {
    const entity = allEntities.find(e => e.id === n.id);
    const score = influenceScores.get(n.id) || { influenceScore: 0, centrality: { degree: 0, betweenness: 0, eigenvector: 0 } };
    const bridge = bridges.find(b => b.entity.id === n.id);
    const cIndex = graphAnalytics.community.communityOf[n.id] ?? -1;

    const stanceSummary: Record<string, any> = {};
    if (entity?.properties?.stance_profiles) {
      for (const [target, profile] of Object.entries(entity.properties.stance_profiles) as any) {
        stanceSummary[target] = {
          sentiment: profile.sentimentLabel,
          score: profile.score,
          confidence: profile.confidence,
        };
      }
    }

    // Count follows
    const followerCount = allRelationships.filter(r => r.label === 'follows' && r.targetId === n.id).length;
    const followingCount = allRelationships.filter(r => r.label === 'follows' && r.sourceId === n.id).length;

    const node: InfluenceNode = {
      id: n.id,
      label: entity?.label || n.id,
      type: entity?.type || 'unknown',
      communityIndex: cIndex,
      influenceScore: score.influenceScore,
      centrality: score.centrality,
      stanceSummary,
      followerCount,
      followingCount,
      isBridge: !!bridge,
      bridgeScore: bridge?.bridgeStrength,
      bridgedCommunities: bridge?.communitiesBridged,
    };

    return node;
  });

  // Top influencers sorted by score
  const topInfluencers = [...allNodes]
    .sort((a, b) => b.influenceScore - a.influenceScore)
    .slice(0, 20);

  return {
    analyzedAt: new Date().toISOString(),
    graphStats: {
      totalNodes: graphInput.nodes.length,
      totalEdges: graphInput.links.length,
      communityCount: graphAnalytics.community.count,
      modularity: graphAnalytics.community.modularity,
    },
    communities,
    topInfluencers,
    bridges,
    narrativeTraces,
    graphAnalytics,
  };
}

// ──────────────────────────────────────────────────────────────
//  GRAPH LOADING
// ──────────────────────────────────────────────────────────────

async function loadFullGraph(): Promise<{ entities: PersonalEntity[]; relationships: PersonalRelationship[] }> {
  const result = await getEntities({ limit: 1000 });
  const relationships = await getRelationships();
  return { entities: result.entities, relationships };
}

function buildGraphInput(
  entities: PersonalEntity[],
  relationships: PersonalRelationship[],
): AnalyticsGraphInput {
  return {
    nodes: entities.map(e => ({ id: e.id, label: e.label, type: e.type, domain: e.domain })),
    links: relationships.map(r => ({
      source: r.sourceId,
      target: r.targetId,
      strength: r.strength,
      label: r.label,
    })),
  };
}

// ──────────────────────────────────────────────────────────────
//  INFLUENCE SCORING
// ──────────────────────────────────────────────────────────────

interface InfluenceScoreResult {
  influenceScore: number;
  centrality: { degree: number; betweenness: number; eigenvector: number };
}

/**
 * Compute influence scores combining:
 * - Graph centrality (betweenness = 0.45, eigenvalue = 0.30, degree = 0.25)
 * - Follower count boost
 * - Stance profile richness (having opinions = being vocal = influence)
 * - Origination score (being first to mention a topic)
 */
function computeInfluenceScores(
  graph: AnalyticsGraphInput,
  analytics: GraphAnalyticsResult,
  entities: PersonalEntity[],
  relationships: PersonalRelationship[],
): Map<string, InfluenceScoreResult> {
  const scores = new Map<string, InfluenceScoreResult>();

  const centrality = analytics.centrality;
  // Compute max followers safely
  let maxFollowers = 1;
  try {
    const followerCounts: Record<string, number> = {};
    for (const r of relationships) {
      if (r.label === 'follows') {
        followerCounts[r.targetId] = (followerCounts[r.targetId] || 0) + 1;
      }
    }
    const counts = Object.values(followerCounts);
    if (counts.length > 0) maxFollowers = Math.max(1, ...counts);
  } catch { /* use default */ }

  for (const node of graph.nodes) {
    const entity = entities.find(e => e.id === node.id);

    // Base: blended centrality (same formula as topInfluencers in graph-analytics.ts)
    const blendScore =
      0.45 * (centrality.betweenness[node.id] || 0) +
      0.30 * (centrality.eigenvector[node.id] || 0) +
      0.25 * (centrality.degree[node.id] || 0);

    // Follower boost: log-scale follower count
    const followerCount = relationships.filter(r => r.label === 'follows' && r.targetId === node.id).length;
    const followerBoost = Math.log2(1 + followerCount) / Math.log2(1 + maxFollowers);

    // Stance richness boost: having strong opinions = being influential
    const profiles = entity?.properties?.stance_profiles;
    const stanceCount = profiles ? Object.keys(profiles).length : 0;
    const stanceBoost = Math.min(0.15, stanceCount * 0.03);

    // Composite score
    const influenceScore = Math.min(1,
      blendScore * 0.5 +
      followerBoost * 0.3 +
      stanceBoost +
      0.05, // baseline
    );

    scores.set(node.id, {
      influenceScore: Math.round(influenceScore * 1000) / 1000,
      centrality: {
        degree: centrality.degree[node.id] || 0,
        betweenness: centrality.betweenness[node.id] || 0,
        eigenvector: centrality.eigenvector[node.id] || 0,
      },
    });
  }

  return scores;
}

// ──────────────────────────────────────────────────────────────
//  OPINION COMMUNITY DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Enrich graph communities with stance analysis and topic data.
 * Opinion communities are Louvain clusters + stance similarity.
 */
function buildOpinionCommunities(
  analytics: GraphAnalyticsResult,
  entities: PersonalEntity[],
  influenceScores: Map<string, InfluenceScoreResult>,
): OpinionCommunity[] {
  const communities: OpinionCommunity[] = [];

  for (let i = 0; i < analytics.community.count; i++) {
    const memberIds = analytics.community.communities[i] || [];
    const members = memberIds
      .map(id => entities.find(e => e.id === id))
      .filter((e): e is PersonalEntity => !!e);

    // Aggregate stance for this community
    const stanceAccum: Record<string, { totalScore: number; count: number }> = {};
    const topicAccum: Record<string, number> = {};

    for (const member of members) {
      const profiles = member.properties?.stance_profiles;
      if (profiles) {
        for (const [target, profile] of Object.entries(profiles) as any) {
          if (!stanceAccum[target]) stanceAccum[target] = { totalScore: 0, count: 0 };
          stanceAccum[target].totalScore += profile.score;
          stanceAccum[target].count++;
        }
      }

      // Collect topics from tags
      for (const tag of member.tags || []) {
        if (tag.startsWith('topic:')) {
          const topic = tag.replace('topic:', '');
          topicAccum[topic] = (topicAccum[topic] || 0) + 1;
        }
      }
    }

    const dominantStances = Object.entries(stanceAccum)
      .filter(([_, v]) => v.count >= 2) // require at least 2 members expressing this
      .map(([target, v]) => ({
        target,
        avgScore: Math.round((v.totalScore / v.count) * 100) / 100,
        members: v.count,
      }))
      .sort((a, b) => Math.abs(b.avgScore) - Math.abs(a.avgScore))
      .slice(0, 5);

    const sharedTopics = Object.entries(topicAccum)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t]) => t);

    // Label the community based on its dominant stance
    let label = `Community ${i + 1}`;
    if (dominantStances.length > 0) {
      const top = dominantStances[0];
      const direction = top.avgScore > 0.3 ? 'pro' : top.avgScore < -0.3 ? 'anti' : 'neutral';
      label = `${direction}-${top.target}`;
    } else if (sharedTopics.length > 0) {
      label = sharedTopics.slice(0, 2).join('+');
    }

    // Top influencers in this community
    const topInfluencers = memberIds
      .map(id => {
        const score = influenceScores.get(id);
        const entity = entities.find(e => e.id === id);
        return {
          id,
          label: entity?.label || id,
          type: entity?.type || 'unknown',
          communityIndex: i,
          influenceScore: score?.influenceScore || 0,
          centrality: score?.centrality || { degree: 0, betweenness: 0, eigenvector: 0 },
          stanceSummary: {},
          followerCount: 0,
          followingCount: 0,
          isBridge: false,
        };
      })
      .sort((a, b) => b.influenceScore - a.influenceScore)
      .slice(0, 5);

    communities.push({
      index: i,
      size: memberIds.length,
      dominantStances,
      topInfluencers,
      color: communityColor(i),
      sharedTopics,
      label,
    });
  }

  return communities.sort((a, b) => b.size - a.size);
}

// ──────────────────────────────────────────────────────────────
//  BRIDGE DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Find entities that bridge otherwise separate communities.
 * These are nodes whose edges cross community boundaries.
 */
function detectBridgeAccounts(
  graph: AnalyticsGraphInput,
  analytics: GraphAnalyticsResult,
  entities: PersonalEntity[],
  influenceScores: Map<string, InfluenceScoreResult>,
): BridgeAccount[] {
  const communityOf = analytics.community.communityOf;
  const bridges: BridgeAccount[] = [];

  // Build adjacency: for each entity, which communities are its edges connected to?
  const nodeCommunities: Record<string, Set<number>> = {};

  for (const link of graph.links) {
    const source = typeof link.source === 'string' ? link.source : (link.source as any)?.id;
    const target = typeof link.target === 'string' ? link.target : (link.target as any)?.id;
    if (!source || !target) continue;

    const srcComm = communityOf[source];
    const tgtComm = communityOf[target];
    if (srcComm === undefined || tgtComm === undefined) continue;

    // Source connects to target's community
    if (!nodeCommunities[source]) nodeCommunities[source] = new Set();
    nodeCommunities[source].add(tgtComm);

    // Target connects to source's community
    if (!nodeCommunities[target]) nodeCommunities[target] = new Set();
    nodeCommunities[target].add(srcComm);
  }

  // Score bridges: entities whose connections span multiple communities
  for (const [nodeId, communities] of Object.entries(nodeCommunities)) {
    if (communities.size <= 1) continue; // Not a bridge

    // Remove self-community
    const ownCommunity = communityOf[nodeId];
    const otherCommunities = [...communities].filter(c => c !== ownCommunity);

    if (otherCommunities.length === 0) continue;

    const entity = entities.find(e => e.id === nodeId);
    const score = influenceScores.get(nodeId);

    // Find the bridging edges
    const bridgingEdges: BridgeAccount['bridgingEdges'] = [];
    for (const link of graph.links) {
      const source = typeof link.source === 'string' ? link.source : (link.source as any)?.id;
      const target = typeof link.target === 'string' ? link.target : (link.target as any)?.id;
      if (source !== nodeId && target !== nodeId) continue;

      const otherId = source === nodeId ? target : source;
      const otherComm = communityOf[otherId];
      if (otherComm !== undefined && otherComm !== ownCommunity) {
        const otherEntity = entities.find(e => e.id === otherId);
        bridgingEdges.push({
          targetId: otherId,
          targetLabel: otherEntity?.label || otherId,
          targetCommunity: otherComm,
          relationship: (link as any).label || 'connected',
        });
      }
    }

    // Bridge strength: number of communities bridged × edge density
    const bridgeStrength = Math.min(1,
      (otherCommunities.length / Math.max(1, communities.size)) *
      Math.min(1, bridgingEdges.length / 3),
    );

    bridges.push({
      entity: {
        id: nodeId,
        label: entity?.label || nodeId,
        type: entity?.type || 'unknown',
        communityIndex: ownCommunity ?? -1,
        influenceScore: score?.influenceScore || 0,
        centrality: score?.centrality || { degree: 0, betweenness: 0, eigenvector: 0 },
        stanceSummary: {},
        followerCount: 0,
        followingCount: 0,
        isBridge: true,
        bridgeScore: Math.round(bridgeStrength * 100) / 100,
        bridgedCommunities: otherCommunities,
      },
      communitiesBridged: otherCommunities,
      bridgeStrength: Math.round(bridgeStrength * 100) / 100,
      bridgingEdges,
    });
  }

  return bridges.sort((a, b) => b.bridgeStrength - a.bridgeStrength).slice(0, 30);
}

// ──────────────────────────────────────────────────────────────
//  NARRATIVE TRACING
// ──────────────────────────────────────────────────────────────

/**
 * Trace how a stance/topic propagates through the graph.
 *
 * For each key stance target found in stance profiles, identify:
 * - Who originated it (earliest appearance)
 * - How it spread (temporal chain of follows/shares/comments)
 * - Current reach
 */
async function traceNarratives(
  graph: AnalyticsGraphInput,
  analytics: GraphAnalyticsResult,
  entities: PersonalEntity[],
  relationships: PersonalRelationship[],
): Promise<NarrativeTrace[]> {
  const traces: NarrativeTrace[] = [];

  // Collect all stance targets with enough actors
  const stanceTargets = new Map<string, { entityId: string; timestamp: string }[]>();

  for (const entity of entities) {
    const profiles = entity.properties?.stance_profiles;
    if (!profiles) continue;

    for (const [target, profile] of Object.entries(profiles) as any) {
      if ((profile.count?.total || 0) < 1) continue;
      if (!stanceTargets.has(target)) stanceTargets.set(target, []);
      stanceTargets.get(target)!.push({
        entityId: entity.id,
        timestamp: profile.lastUpdated || entity.updatedAt || entity.createdAt,
      });
    }
  }

  // For the top stance targets, build narrative traces
  const sortedTargets = [...stanceTargets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  for (const [target, mentions] of sortedTargets) {
    // Sort mentions by timestamp
    mentions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (mentions.length < 2) {
      // Single mention — no propagation
      const originator = entities.find(e => e.id === mentions[0]?.entityId);
      traces.push({
        topic: target,
        originator: { id: originator?.id || '', label: originator?.label || 'unknown' },
        propagationPath: [],
        reachCount: 1,
        maxDepth: 0,
        timeSpanMs: 0,
      });
      continue;
    }

    const originator = entities.find(e => e.id === mentions[0].entityId);
    const originTime = new Date(mentions[0].timestamp).getTime();
    const latestTime = new Date(mentions[mentions.length - 1].timestamp).getTime();

    // Build propagation path: trace from originator through follows/shares/comments
    const mentionIds = new Set(mentions.map(m => m.entityId));
    const path: NarrativeTrace['propagationPath'] = [];
    let maxDepth = 0;

    // For each mention (except origin), find the shortest graph path from originator
    for (let i = 1; i < mentions.length; i++) {
      const mentioner = mentions[i];
      if (mentioner.entityId === mentions[0].entityId) continue; // same person

      // Use existing pathfinding from graph-analytics
      const pathResult = findShortestPath(graph, mentions[0].entityId, mentioner.entityId);
      if (pathResult.reachable) {
        // Add each hop as a propagation step
        for (let j = 0; j < pathResult.edges.length; j++) {
          const [fromId, toId] = pathResult.edges[j];
          if (toId === mentioner.entityId || fromId === mentions[0].entityId) {
            // Find the relationship between from and to
            const rel = relationships.find(
              r => (r.sourceId === fromId && r.targetId === toId) ||
                   (r.sourceId === toId && r.targetId === fromId),
            );
            path.push({
              fromId,
              toId,
              viaRelationship: rel?.label || 'connected',
              timestamp: mentioner.timestamp,
              step: j + 1,
            });
          }
        }
        maxDepth = Math.max(maxDepth, pathResult.hops);
      }
    }

    traces.push({
      topic: target,
      originator: {
        id: originator?.id || mentions[0].entityId,
        label: originator?.label || mentions[0].entityId,
      },
      propagationPath: path.slice(0, 50), // cap to 50 steps
      reachCount: mentionIds.size,
      maxDepth,
      timeSpanMs: latestTime - originTime,
    });
  }

  return traces.sort((a, b) => b.reachCount - a.reachCount);
}

// ──────────────────────────────────────────────────────────────
//  NARRATIVE PROPAGATION QUERY
// ──────────────────────────────────────────────────────────────

/**
 * Given a stance target and the originating entity, trace how
 * that narrative propagates through the graph via temporal
 * relationship chains.
 */
export async function traceNarrativeFromOrigin(
  topic: string,
  originatorId: string,
): Promise<NarrativeTrace | null> {
  const { entities, relationships } = await loadFullGraph();
  const graphInput = buildGraphInput(entities, relationships);
  const analytics = analyzeGraph(graphInput);

  // Find all entities with this stance target
  const mentions: { entityId: string; timestamp: string }[] = [];
  for (const entity of entities) {
    const profiles = entity.properties?.stance_profiles;
    if (!profiles) continue;
    const profile = profiles[topic.toLowerCase()];
    if (profile && profile.count?.total > 0) {
      mentions.push({
        entityId: entity.id,
        timestamp: profile.lastUpdated || entity.updatedAt || entity.createdAt,
      });
    }
  }

  // Add origin if not present
  if (!mentions.some(m => m.entityId === originatorId)) {
    const orig = entities.find(e => e.id === originatorId);
    if (orig) {
      mentions.unshift({
        entityId: originatorId,
        timestamp: orig.createdAt,
      });
    }
  }

  mentions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (mentions.length < 2) {
    return {
      topic,
      originator: { id: originatorId, label: entities.find(e => e.id === originatorId)?.label || originatorId },
      propagationPath: [],
      reachCount: mentions.length,
      maxDepth: 0,
      timeSpanMs: 0,
    };
  }

  const originTime = new Date(mentions[0].timestamp).getTime();
  const latestTime = new Date(mentions[mentions.length - 1].timestamp).getTime();

  const path: NarrativeTrace['propagationPath'] = [];
  let maxDepth = 0;
  const mentionIds = new Set(mentions.map(m => m.entityId));

  for (let i = 1; i < mentions.length; i++) {
    const mentioner = mentions[i];
    if (mentioner.entityId === originatorId) continue;

    const pathResult = findShortestPath(graphInput, originatorId, mentioner.entityId);
    if (pathResult.reachable) {
      for (let j = 0; j < pathResult.edges.length; j++) {
        const [fromId, toId] = pathResult.edges[j];
        if (toId === mentioner.entityId || fromId === originatorId) {
          const rel = relationships.find(
            r => (r.sourceId === fromId && r.targetId === toId) ||
                 (r.sourceId === toId && r.targetId === fromId),
          );
          path.push({
            fromId,
            toId,
            viaRelationship: rel?.label || 'connected',
            timestamp: mentioner.timestamp,
            step: j + 1,
          });
        }
      }
      maxDepth = Math.max(maxDepth, pathResult.hops);
    }
  }

  return {
    topic,
    originator: {
      id: originatorId,
      label: entities.find(e => e.id === originatorId)?.label || originatorId,
    },
    propagationPath: path.slice(0, 50),
    reachCount: mentionIds.size,
    maxDepth,
    timeSpanMs: latestTime - originTime,
  };
}

// ──────────────────────────────────────────────────────────────
//  INFLUENCER RANKING
// ──────────────────────────────────────────────────────────────

/**
 * Get ranked influencers for a specific topic/stance.
 */
export async function getInfluencersForTopic(
  topic: string,
  minStanceConfidence: number = 0.2,
): Promise<InfluenceNode[]> {
  const analysis = await runInfluenceAnalysis();

  // Filter to entities that have stance data for this topic
  return analysis.topInfluencers.filter(n =>
    n.stanceSummary[topic.toLowerCase()] &&
    n.stanceSummary[topic.toLowerCase()].confidence >= minStanceConfidence,
  );
}

/**
 * Get all bridge accounts.
 */
export async function getBridgeAccounts(): Promise<BridgeAccount[]> {
  const analysis = await runInfluenceAnalysis();
  return analysis.bridges;
}
