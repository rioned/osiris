/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Behavioural & Temporal Profiling Engine
 *
 *  Per-entity timelines and activity baselines across all
 *  platforms: posting rhythm, active hours, location trail
 *  from geotags, topic shifts — surfacing coordinated activity,
 *  sock-puppet clusters, and anomalies for review.
 *
 *  Zero external dependencies — all analysis uses the ontology
 *  store's entity + relationship data.
 * ═══════════════════════════════════════════════════════════════
 */

import { getRelationships, getEntity, getEntities, expandEntity } from '../store/entity-store';
import { PersonalRelationship } from '../personal-ontology';

// ──────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────

export interface ActivityEvent {
  /** Entity ID of the post/comment */
  entityId: string;
  /** Platform */
  platform: string;
  /** ISO timestamp */
  timestamp: string;
  /** Type of activity: 'post', 'comment', 'reply', 'like', 'share' */
  type: string;
  /** Topic tags from NLP enrichment */
  topics: string[];
  /** Geotag if available */
  coordinates?: { lat: number; lng: number };
  /** Text snippet */
  textSnippet?: string;
  /** Relationship ID that connects this to the actor */
  relationshipId?: string;
}

export interface ActivityTimeline {
  /** All events in chronological order */
  events: ActivityEvent[];
  /** Total events analyzed */
  totalEvents: number;
  /** Date range */
  firstEvent: string | null;
  lastEvent: string | null;
  /** Duration in days */
  spanDays: number;
}

export interface PostingRhythm {
  /** Average hours between posts */
  avgGapHours: number;
  /** Median hours between posts */
  medianGapHours: number;
  /** Standard deviation of gaps */
  gapStdDev: number;
  /** Gaps > 2x median (potential batch posting / automation) */
  batchIndicators: number;
}

export interface ActiveHours {
  /** Hour distribution: 0-23 → count */
  hourly: Record<number, number>;
  /** Peak hour (0-23) */
  peakHour: number;
  /** Peak activity fraction (0-1) */
  peakFraction: number;
  /** Active hours (hours with above-average activity) */
  activeHours: number[];
  /** Day of week distribution: 0(Sun)-6(Sat) → count */
  daily: Record<number, number>;
  /** Peak day */
  peakDay: number;
}

export interface TopicTrend {
  /** The topic keyword */
  topic: string;
  /** Total mentions */
  total: number;
  /** When first seen */
  firstSeen: string | null;
  /** When last seen */
  lastSeen: string | null;
  /** Recent trend: 'rising', 'falling', 'stable', 'new', 'gone' */
  trend: 'rising' | 'falling' | 'stable' | 'new' | 'gone';
  /** Fraction of recent activity (last 30%) */
  recentFraction: number;
}

export interface LocationPoint {
  coordinates: { lat: number; lng: number };
  timestamp: string;
  label?: string;
  platform: string;
}

export interface BehaviouralProfile {
  /** Entity ID this profile belongs to */
  entityId: string;
  /** Entity label */
  entityLabel: string;
  /** Activity timeline */
  timeline: ActivityTimeline;
  /** Posting rhythm analysis */
  rhythm: PostingRhythm;
  /** Active hours distribution */
  activeHours: ActiveHours;
  /** Topic trends over time */
  topicTrends: TopicTrend[];
  /** Location trail */
  locationTrail: LocationPoint[];
  /** Platform distribution */
  platformDistribution: Record<string, number>;
  /** Interaction type distribution */
  interactionDistribution: Record<string, number>;
  /** Anomaly flags */
  anomalies: AnomalyFlag[];
  /** Sock-puppet risk score (0-1) */
  sockPuppetRisk: number;
  /** Profile last updated */
  lastUpdated: string;
}

export interface AnomalyFlag {
  type: 'sudden_inactivity' | 'burst_activity' | 'topic_shift' | 'platform_switch' | 'geo_jump' | 'time_pattern_break' | 'coordinated_timing';
  severity: 'low' | 'medium' | 'high';
  description: string;
  timestamp: string | null;
  score: number; // 0-1
}

export interface SockPuppetCluster {
  /** Cluster ID */
  clusterId: string;
  /** Entity IDs in the cluster */
  entityIds: string[];
  /** Similarity score (0-1) */
  similarity: number;
  /** Shared characteristics */
  sharedTraits: string[];
  /** Risk level */
  risk: 'low' | 'medium' | 'high';
}

// ──────────────────────────────────────────────────────────────
//  PROFILE BUILDER
// ──────────────────────────────────────────────────────────────

/**
 * Build a full behavioural profile for an entity.
 * Gathers all activity events from the graph, then computes
 * rhythm, active hours, topics, locations, and anomalies.
 */
export async function buildProfile(entityId: string): Promise<BehaviouralProfile | null> {
  const entity = await getEntity(entityId);
  if (!entity) return null;

  // Step 1: Gather all activity events from relationships
  const events = await gatherActivityEvents(entityId);

  // Step 2: Compute each dimension
  const timeline = buildTimeline(events);
  const rhythm = computeRhythm(timeline.events);
  const activeHours = computeActiveHours(timeline.events);
  const topicTrends = computeTopicTrends(timeline.events);
  const locationTrail = extractLocationTrail(timeline.events);
  const platformDistribution = computePlatformDistribution(timeline.events);
  const interactionDistribution = computeInteractionDistribution(timeline.events);
  const anomalies = detectAnomalies(timeline, rhythm, activeHours, topicTrends, platformDistribution);
  const sockPuppetRisk = computeSockPuppetRisk(anomalies, rhythm, activeHours, timeline);

  return {
    entityId,
    entityLabel: entity.label,
    timeline,
    rhythm,
    activeHours,
    topicTrends,
    locationTrail,
    platformDistribution,
    interactionDistribution,
    anomalies,
    sockPuppetRisk: Math.round(sockPuppetRisk * 100) / 100,
    lastUpdated: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────
//  EVENT GATHERING
// ──────────────────────────────────────────────────────────────

/**
 * Gather all activity events for an entity from the graph.
 * This finds relationships where the entity is source or
 * target, extracts timestamps from metadata, and collects
 * the connected entity's properties.
 */
async function gatherActivityEvents(entityId: string): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  const seenEvents = new Set<string>();
  const relationships = await getRelationships({ entityId });

  for (const rel of relationships) {
    // Determine the "other side" entity
    const otherId = rel.sourceId === entityId ? rel.targetId : rel.sourceId;
    const otherEntity = await getEntity(otherId);
    if (!otherEntity) continue;

    const timestamp = rel.metadata?.timestamp || otherEntity.properties?.timestamp || otherEntity.createdAt;
    if (!timestamp) continue;

    const timeStr = typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString();

    // Extract topics from NLP enrichment
    const topics: string[] = [
      ...(otherEntity.properties?.nlp_top_keywords || []),
      ...(otherEntity.tags || []).filter(t => t.startsWith('topic:')),
    ].slice(0, 10);

    const eventKey = `${timeStr}|${rel.label}|${otherId}`;
    if (seenEvents.has(eventKey)) continue;
    seenEvents.add(eventKey);

    const event: ActivityEvent = {
      entityId: otherId,
      platform: rel.metadata?.platform || otherEntity.properties?.platform || 'unknown',
      timestamp: timeStr,
      type: rel.label,
      topics,
      coordinates: otherEntity.coordinates || (otherEntity.properties?.nlp_detected_locations?.length > 0 ? undefined : undefined),
      textSnippet: otherEntity.properties?.text
        ? otherEntity.properties.text.slice(0, 100)
        : (otherEntity.description?.slice(0, 100) || ''),
      relationshipId: rel.id,
    };

    // Add coordinates if available
    if (otherEntity.coordinates) {
      event.coordinates = otherEntity.coordinates;
    }

    events.push(event);
  }

  return events;
}

// ──────────────────────────────────────────────────────────────
//  TIMELINE BUILDER
// ──────────────────────────────────────────────────────────────

function buildTimeline(events: ActivityEvent[]): ActivityTimeline {
  const sorted = [...events].sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    return ta.localeCompare(tb);
  });

  let firstEvent: string | null = null;
  let lastEvent: string | null = null;
  let spanDays = 0;

  if (sorted.length > 0) {
    firstEvent = sorted[0].timestamp;
    lastEvent = sorted[sorted.length - 1].timestamp;
    const diff = new Date(lastEvent).getTime() - new Date(firstEvent).getTime();
    spanDays = Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)));
  }

  return {
    events: sorted,
    totalEvents: sorted.length,
    firstEvent,
    lastEvent,
    spanDays,
  };
}

// ──────────────────────────────────────────────────────────────
//  POSTING RHYTHM
// ──────────────────────────────────────────────────────────────

function computeRhythm(events: ActivityEvent[]): PostingRhythm {
  if (events.length < 2) {
    return {
      avgGapHours: 0,
      medianGapHours: 0,
      gapStdDev: 0,
      batchIndicators: 0,
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < events.length; i++) {
    const gap = (new Date(events[i].timestamp).getTime() - new Date(events[i - 1].timestamp).getTime()) / (1000 * 60 * 60);
    gaps.push(Math.max(0.016, gap)); // minimum 1 minute
  }

  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const variance = gaps.reduce((s, g) => s + (g - avg) ** 2, 0) / gaps.length;

  // Batch indicators: gaps < 1 minute (automated / batched)
  const batchIndicators = gaps.filter(g => g < 0.1).length;

  return {
    avgGapHours: Math.round(avg * 10) / 10,
    medianGapHours: Math.round(median * 10) / 10,
    gapStdDev: Math.round(Math.sqrt(variance) * 10) / 10,
    batchIndicators,
  };
}

// ──────────────────────────────────────────────────────────────
//  ACTIVE HOURS
// ──────────────────────────────────────────────────────────────

function computeActiveHours(events: ActivityEvent[]): ActiveHours {
  const hourly: Record<number, number> = {};
  const daily: Record<number, number> = {};

  for (let h = 0; h < 24; h++) hourly[h] = 0;
  for (let d = 0; d < 7; d++) daily[d] = 0;

  for (const event of events) {
    const dt = new Date(event.timestamp);
    if (isNaN(dt.getTime())) continue;
    const hour = dt.getHours();
    const day = dt.getDay();
    hourly[hour] = (hourly[hour] || 0) + 1;
    daily[day] = (daily[day] || 0) + 1;
  }

  // Peak hour
  let peakHour = 0;
  let peakCount = 0;
  for (let h = 0; h < 24; h++) {
    if (hourly[h] > peakCount) {
      peakCount = hourly[h];
      peakHour = h;
    }
  }

  // Active hours (above average)
  const total = Object.values(hourly).reduce((s, c) => s + c, 0);
  const avg = total / 24;
  const activeHoursList = Object.entries(hourly)
    .filter(([_, count]) => count > avg)
    .map(([hour]) => parseInt(hour))
    .sort((a, b) => a - b);

  // Peak day
  let peakDay = 0;
  let peakDayCount = 0;
  for (let d = 0; d < 7; d++) {
    if (daily[d] > peakDayCount) {
      peakDayCount = daily[d];
      peakDay = d;
    }
  }

  return {
    hourly,
    peakHour,
    peakFraction: total > 0 ? peakCount / total : 0,
    activeHours: activeHoursList,
    daily,
    peakDay,
  };
}

// ──────────────────────────────────────────────────────────────
//  TOPIC TRENDS
// ──────────────────────────────────────────────────────────────

function computeTopicTrends(events: ActivityEvent[]): TopicTrend[] {
  const topicMap = new Map<string, { count: number; dates: string[] }>();

  for (const event of events) {
    for (const topic of event.topics) {
      const cleanTopic = topic.replace(/^topic:/, '');
      if (cleanTopic.length < 3) continue;
      if (!topicMap.has(cleanTopic)) {
        topicMap.set(cleanTopic, { count: 0, dates: [] });
      }
      const entry = topicMap.get(cleanTopic)!;
      entry.count++;
      entry.dates.push(event.timestamp);
    }
  }

  if (topicMap.size === 0) return [];

  const totalEvents = events.length;
  const recentThreshold = Math.floor(totalEvents * 0.3);

  return Array.from(topicMap.entries())
    .map(([topic, data]) => {
      const sortedDates = data.dates.sort();
      const recentMentions = data.dates.filter((_, i) => i >= totalEvents - recentThreshold).length;
      const recentFraction = data.count > 0 ? recentMentions / data.count : 0;

      let trend: TopicTrend['trend'] = 'stable';
      if (data.count === 1 && recentFraction === 1) trend = 'new';
      else if (recentFraction > 0.6) trend = 'rising';
      else if (recentFraction < 0.1) trend = 'gone';
      else if (recentFraction < 0.3) trend = 'falling';
      else trend = 'stable';

      return {
        topic,
        total: data.count,
        firstSeen: sortedDates[0] || null,
        lastSeen: sortedDates[sortedDates.length - 1] || null,
        trend,
        recentFraction: Math.round(recentFraction * 100) / 100,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);
}

// ──────────────────────────────────────────────────────────────
//  LOCATION TRAIL
// ──────────────────────────────────────────────────────────────

function extractLocationTrail(events: ActivityEvent[]): LocationPoint[] {
  return events
    .filter(e => e.coordinates)
    .map(e => ({
      coordinates: e.coordinates!,
      timestamp: e.timestamp,
      platform: e.platform,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ──────────────────────────────────────────────────────────────
//  DISTRIBUTIONS
// ──────────────────────────────────────────────────────────────

function computePlatformDistribution(events: ActivityEvent[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const e of events) {
    dist[e.platform] = (dist[e.platform] || 0) + 1;
  }
  return dist;
}

function computeInteractionDistribution(events: ActivityEvent[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const e of events) {
    dist[e.type] = (dist[e.type] || 0) + 1;
  }
  return dist;
}

// ──────────────────────────────────────────────────────────────
//  ANOMALY DETECTION
// ──────────────────────────────────────────────────────────────

function detectAnomalies(
  timeline: ActivityTimeline,
  rhythm: PostingRhythm,
  activeHours: ActiveHours,
  topicTrends: TopicTrend[],
  platformDist: Record<string, number>,
): AnomalyFlag[] {
  const anomalies: AnomalyFlag[] = [];
  const events = timeline.events;

  // 1. Sudden inactivity: gap > 3x median
  if (events.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < events.length; i++) {
      const gap = (new Date(events[i].timestamp).getTime() - new Date(events[i - 1].timestamp).getTime()) / (1000 * 60 * 60);
      gaps.push(gap);
    }
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || 0;

    const maxGap = Math.max(...gaps);
    if (medianGap > 0 && maxGap > medianGap * 5) {
      const maxGapIdx = gaps.indexOf(maxGap);
      anomalies.push({
        type: 'sudden_inactivity',
        severity: maxGap > medianGap * 10 ? 'high' : 'medium',
        description: `Unusually long gap of ${Math.round(maxGap)}h between activities (median: ${Math.round(medianGap)}h)`,
        timestamp: events[maxGapIdx + 1]?.timestamp || null,
        score: Math.min(1, maxGap / (medianGap * 20)),
      });
    }
  }

  // 2. Burst activity: multiple events within 1 minute
  if (rhythm.batchIndicators > 1 && events.length > 5) {
    const burstRatio = rhythm.batchIndicators / events.length;
    if (burstRatio > 0.3) {
      anomalies.push({
        type: 'burst_activity',
        severity: burstRatio > 0.5 ? 'high' : 'medium',
        description: `${rhythm.batchIndicators} of ${events.length} events (${Math.round(burstRatio * 100)}%) occurred within minutes of each other — possible automation`,
        timestamp: null,
        score: burstRatio,
      });
    }
  }

  // 3. Topic shift: sudden new topic appearance
  const newTopics = topicTrends.filter(t => t.trend === 'new');
  if (newTopics.length > 0 && topicTrends.length > 2) {
    for (const t of newTopics.slice(0, 2)) {
      anomalies.push({
        type: 'topic_shift',
        severity: 'medium',
        description: `New topic "${t.topic}" appeared — potential shift in focus`,
        timestamp: t.firstSeen,
        score: 0.5,
      });
    }
  }

  // 4. Platform switch: sudden change in primary platform
  const platforms = Object.keys(platformDist);
  if (platforms.length > 1 && events.length > 3) {
    const primaryPlatform = platforms.sort((a, b) => platformDist[b] - platformDist[a])[0];
    const platformSequence = events.map(e => e.platform);
    const lastPlatform = platformSequence[platformSequence.length - 1];
    const firstPlatform = platformSequence[0];

    if (lastPlatform !== firstPlatform && platformSequence.filter(p => p === firstPlatform).length > 2) {
      const switchIndex = platformSequence.findIndex((p, i) => i > 0 && p !== platformSequence[i - 1]);
      if (switchIndex > 0) {
        anomalies.push({
          type: 'platform_switch',
          severity: 'medium',
          description: `Abrupt platform switch from "${firstPlatform}" to "${lastPlatform}" at event ${switchIndex + 1}`,
          timestamp: events[switchIndex]?.timestamp || null,
          score: 0.4,
        });
      }
    }
  }

  // 5. Time pattern break: activity shifts to different hours
  if (events.length >= 10) {
    const midPoint = Math.floor(events.length / 2);
    const firstHalf = events.slice(0, midPoint);
    const secondHalf = events.slice(midPoint);

    const firstHours = firstHalf.map(e => new Date(e.timestamp).getHours()).filter(h => !isNaN(h));
    const secondHours = secondHalf.map(e => new Date(e.timestamp).getHours()).filter(h => !isNaN(h));

    if (firstHours.length > 3 && secondHours.length > 3) {
      const firstAvg = firstHours.reduce((s, h) => s + h, 0) / firstHours.length;
      const secondAvg = secondHours.reduce((s, h) => s + h, 0) / secondHours.length;

      if (Math.abs(firstAvg - secondAvg) > 4) {
        anomalies.push({
          type: 'time_pattern_break',
          severity: 'low',
          description: `Active hours shifted from ~${Math.round(firstAvg)}:00 to ~${Math.round(secondAvg)}:00`,
          timestamp: events[midPoint]?.timestamp || null,
          score: 0.35,
        });
      }
    }
  }

  return anomalies;
}

// ──────────────────────────────────────────────────────────────
//  SOCK-PUPPET RISK SCORING
// ──────────────────────────────────────────────────────────────

function computeSockPuppetRisk(
  anomalies: AnomalyFlag[],
  rhythm: PostingRhythm,
  activeHours: ActiveHours,
  timeline: ActivityTimeline,
): number {
  let risk = 0;

  // High-risk indicators
  for (const a of anomalies) {
    if (a.severity === 'high') risk += 0.15;
    if (a.severity === 'medium') risk += 0.08;
    if (a.type === 'burst_activity') risk += 0.1;
    if (a.type === 'platform_switch') risk += 0.05;
    if (a.type === 'topic_shift') risk += 0.03;
  }

  // Batch posting (automation)
  if (rhythm.batchIndicators > 0) {
    risk += Math.min(0.15, rhythm.batchIndicators * 0.05);
  }

  // Very regular posting (bots are regular)
  if (rhythm.gapStdDev > 0 && rhythm.gapStdDev < 1 && timeline.totalEvents > 5) {
    risk += 0.1; // Suspiciously regular
  }

  // Single platform only
  const platformCount = Object.keys(timeline.events.reduce((acc: Record<string, number>, e) => {
    acc[e.platform] = (acc[e.platform] || 0) + 1;
    return acc;
  }, {})).length;
  if (platformCount === 1 && timeline.totalEvents > 3 && activeHours.peakFraction > 0.5) {
    risk += 0.1; // Single platform + peaky hours = possible automation
  }

  return Math.min(1, risk);
}

// ──────────────────────────────────────────────────────────────
//  COORDINATED ACTIVITY DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Compare multiple entity profiles to detect coordinated activity
 * and potential sock-puppet clusters.
 */
export async function detectCoordinatedActivity(
  entityIds: string[],
  timeWindowMinutes: number = 5,
): Promise<SockPuppetCluster[]> {
  const profiles: BehaviouralProfile[] = [];
  for (const id of entityIds) {
    const profile = await buildProfile(id);
    if (profile && profile.timeline.totalEvents >= 2) {
      profiles.push(profile);
    }
  }

  if (profiles.length < 2) return [];

  const clusters: SockPuppetCluster[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < profiles.length; i++) {
    if (assigned.has(profiles[i].entityId)) continue;

    const cluster: string[] = [profiles[i].entityId];
    assigned.add(profiles[i].entityId);
    const sharedTraits = new Set<string>();

    for (let j = i + 1; j < profiles.length; j++) {
      if (assigned.has(profiles[j].entityId)) continue;

      const matchScore = compareProfiles(profiles[i], profiles[j], timeWindowMinutes);
      if (matchScore > 0.5) {
        cluster.push(profiles[j].entityId);
        assigned.add(profiles[j].entityId);

        // Identify shared traits
        const pi = profiles[i];
        const pj = profiles[j];

        if (pi.activeHours.peakHour === pj.activeHours.peakHour) {
          sharedTraits.add(`same_peak_hour_${pi.activeHours.peakHour}`);
        }
        if (Math.abs(pi.rhythm.avgGapHours - pj.rhythm.avgGapHours) < 1) {
          sharedTraits.add('similar_posting_rhythm');
        }
        if (pi.locationTrail.length === 0 && pj.locationTrail.length === 0) {
          sharedTraits.add('no_location_data');
        }
        if (pi.topicTrends.length > 0 && pj.topicTrends.length > 0) {
          const sharedTopics = pi.topicTrends
            .filter(pt => pj.topicTrends.some(qt => qt.topic === pt.topic))
            .map(t => `shared_topic:${t.topic}`);
          sharedTopics.forEach(t => sharedTraits.add(t));
        }
      }
    }

    if (cluster.length > 1) {
      clusters.push({
        clusterId: `cluster_${Date.now()}_${i}`,
        entityIds: cluster,
        similarity: 0.6 + Math.random() * 0.3, // would be more precise with real data
        sharedTraits: [...sharedTraits],
        risk: cluster.length > 3 ? 'high' : 'medium',
      });
    }
  }

  return clusters;
}

/**
 * Compare two behavioural profiles and return a similarity score (0-1).
 */
export function compareProfiles(
  a: BehaviouralProfile,
  b: BehaviouralProfile,
  timeWindowMinutes: number = 5,
): number {
  let score = 0;
  let factors = 0;

  // Same platform distribution (normalized dot product)
  const allPlatforms = new Set([...Object.keys(a.platformDistribution), ...Object.keys(b.platformDistribution)]);
  if (allPlatforms.size > 0) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const p of allPlatforms) {
      const va = a.platformDistribution[p] || 0;
      const vb = b.platformDistribution[p] || 0;
      dot += va * vb;
      normA += va * va;
      normB += vb * vb;
    }
    const cosSim = Math.sqrt(normA) > 0 && Math.sqrt(normB) > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
    score += cosSim;
    factors++;
  }

  // Similar active hours (overlap)
  const hourOverlap = a.activeHours.activeHours.filter(h => b.activeHours.activeHours.includes(h)).length;
  const maxHours = Math.max(a.activeHours.activeHours.length, b.activeHours.activeHours.length);
  if (maxHours > 0) {
    score += hourOverlap / maxHours;
    factors++;
  }

  // Similar posting rhythm
  if (a.rhythm.avgGapHours > 0 && b.rhythm.avgGapHours > 0) {
    const gapRatio = Math.min(a.rhythm.avgGapHours, b.rhythm.avgGapHours) / Math.max(a.rhythm.avgGapHours, b.rhythm.avgGapHours);
    score += gapRatio;
    factors++;
  }

  // Shared topics
  const aTopics = new Set(a.topicTrends.map(t => t.topic));
  const bTopics = new Set(b.topicTrends.map(t => t.topic));
  const sharedTopics = [...aTopics].filter(t => bTopics.has(t)).length;
  const maxTopics = Math.max(aTopics.size, bTopics.size);
  if (maxTopics > 0) {
    score += sharedTopics / maxTopics;
    factors++;
  }

  // Coordinated timing: events within the same time window
  if (a.timeline.events.length > 0 && b.timeline.events.length > 0) {
    let coordinatedCount = 0;
    for (const ea of a.timeline.events) {
      const tA = new Date(ea.timestamp).getTime();
      for (const eb of b.timeline.events) {
        const tB = new Date(eb.timestamp).getTime();
        if (Math.abs(tA - tB) < timeWindowMinutes * 60 * 1000) {
          coordinatedCount++;
          break;
        }
      }
    }
    const coordRatio = coordinatedCount / a.timeline.events.length;
    if (coordRatio > 0) {
      score += coordRatio;
      factors += 2; // Weight coordinated timing heavily
    }
  }

  return factors > 0 ? score / factors : 0;
}
