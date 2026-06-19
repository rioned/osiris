/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — GraphRAG: Question Parsing & Answer Synthesis
 *
 *  Natural-language data-crossing engine that translates a
 *  plain-language question into a multi-hop graph traversal
 *  plan, executes it over the ontology + stance data, then
 *  synthesises a human-readable answer with citations back
 *  to source entities.
 *
 *  Zero-dependency question parser + optional AI synthesis.
 * ═══════════════════════════════════════════════════════════════
 */

import { executeGraphQuery, type QueryPlan, type GraphEntity, type TraversalPath } from './traversal';

// ──────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────

export interface GraphRAGAnswer {
  /** The natural language answer */
  answer: string;
  /** Confidence in the answer (0–1) */
  confidence: number;
  /** Key findings extracted from the graph */
  findings: Finding[];
  /** Whether data was sufficient to answer */
  dataSufficient: boolean;
  /** Warning if data was insufficient */
  warning?: string;
  /** Query execution stats */
  stats: {
    resultsFound: number;
    hopsExecuted: number;
    durationMs: number;
  };
}

export interface Finding {
  /** Entity or relationship description */
  description: string;
  /** Type of finding */
  type: 'entity' | 'relationship' | 'stance' | 'statistic';
  /** Reference entity IDs */
  entityIds: string[];
  /** Evidence explanation */
  evidence: string;
  /** Relevance score */
  relevance: number;
}

// ──────────────────────────────────────────────────────────────
//  QUESTION CLASSIFICATION
// ──────────────────────────────────────────────────────────────

/** Classified question type */
type QuestionType =
  | 'stance_query'          // "users who don't like Rwanda"
  | 'relationship_query'    // "who follows X?"
  | 'multi_hop'             // "who commented on Y and follows Z?"
  | 'entity_search'         // "find posts about AI"
  | 'network_query'         // "contacts who work at the same company"
  | 'intersection_query'    // "users who did A and also B"
  | 'unknown';

interface ParsedQuestion {
  type: QuestionType;
  /** The query plan to execute */
  plan: QueryPlan;
  /** Original question text */
  original: string;
  /** Human-readable description of what's being asked */
  description: string;
  /** Confidence in the parse (0–1) */
  confidence: number;
}

/**
 * Parse a natural language question into a query plan.
 * Uses keyword/pattern matching — no external AI needed.
 */
export function parseQuestion(question: string): ParsedQuestion {
  const q = question.toLowerCase().trim();

  // ── Pattern 1: Stance query ──
  // "users who don't like X" | "people who hate Y" | "who likes Z"
  const stanceNegativeMatch = q.match(/(?:users|people|who|profiles)\s+(?:who\s+)?(?:don't|do not|doesn't|does not)\s+like\s+(.+)/i);
  const stanceStrongNegativeMatch = q.match(/(?:users|people|who|profiles)\s+(?:who\s+)?(?:hate|hates|dislike|oppose|against|negative)\s+(?:about|toward|towards)?\s*(.+)/i);
  const stancePositiveMatch = q.match(/(?:users|people|who|profiles)\s+(?:who\s+)?(?:like|likes|love|loves|support|supports|positive)\s+(?:about|toward|towards)?\s*(.+)/i);

  if (stanceNegativeMatch) {
    const target = stanceNegativeMatch[1].trim();
    return {
      type: 'stance_query',
      description: `Find users with negative stance toward "${target}"`,
      confidence: 0.85,
      original: question,
      plan: {
        seedType: 'social_profile',
        hops: [],
        stanceFilter: { target, sentiment: 'negative', minConfidence: 0.2, minEvidence: 1 },
        maxResults: 50,
        includeIntermediate: false,
      },
    };
  }

  if (stanceStrongNegativeMatch) {
    const target = stanceStrongNegativeMatch[1].trim();
    return {
      type: 'stance_query',
      description: `Find users with negative stance toward "${target}"`,
      confidence: 0.85,
      original: question,
      plan: {
        seedType: 'social_profile',
        hops: [],
        stanceFilter: { target, sentiment: 'negative', minConfidence: 0.2, minEvidence: 1 },
        maxResults: 50,
        includeIntermediate: false,
      },
    };
  }

  if (stancePositiveMatch) {
    const target = stancePositiveMatch[1].trim();
    return {
      type: 'stance_query',
      description: `Find users with positive stance toward "${target}"`,
      confidence: 0.85,
      original: question,
      plan: {
        seedType: 'social_profile',
        hops: [],
        stanceFilter: { target, sentiment: 'positive', minConfidence: 0.2, minEvidence: 1 },
        maxResults: 50,
        includeIntermediate: false,
      },
    };
  }

  // ── Pattern 2: "who commented on [post/YouTube] and also follows [user]" ──
  const multiHopMatch = q.match(/who\s+(?:commented|commented.on|replied.to)\s+(?:on\s+)?(.+?)\s+(?:and|&)\s+(?:also\s+)?(?:follows|liked|shared|mentioned)\s+(.+)/i);
  if (multiHopMatch) {
    const targetContent = multiHopMatch[1].trim();
    const targetRelation = multiHopMatch[2].trim();
    return {
      type: 'multi_hop',
      description: `Find users who commented on "${targetContent}" and also interact with "${targetRelation}"`,
      confidence: 0.7,
      original: question,
      plan: {
        seedSearch: targetContent,
        seedType: 'social_post',
        hops: [
          { relationship: 'commented_on', direction: 'reverse', targetType: 'social_profile', label: 'commented_on' },
          { relationship: ['follows', 'liked', 'shared', 'mentioned'], direction: 'both', targetType: 'social_profile', label: 'interacts_with' },
        ],
        maxResults: 50,
        includeIntermediate: true,
      },
    };
  }

  // ── Pattern 3: Network / "contacts who work at same company" ──
  const networkMatch = q.match(/(?:contacts|connections|friends|followers|network)\s+(?:of|for|who)\s+(.+?)\s+(?:and|who|that)\s+(?:also\s+)?(?:work|works|working|employed)\s+(?:at|for)\s+(.+)/i);
  if (networkMatch) {
    const person = networkMatch[1].trim();
    const company = networkMatch[2].trim();
    return {
      type: 'network_query',
      description: `Find contacts of "${person}" who work at "${company}"`,
      confidence: 0.65,
      original: question,
      plan: {
        seedSearch: person,
        seedType: 'social_profile',
        hops: [
          { relationship: ['follows', 'friend_of'], direction: 'both', targetType: 'social_profile', label: 'connected_to' },
          { relationship: 'works_at', direction: 'forward', targetType: 'social_profile', label: 'works_at' },
        ],
        targetType: 'social_profile',
        maxResults: 30,
        includeIntermediate: true,
      },
    };
  }

  // ── Pattern 4: Who follows X? ──
  const followsMatch = q.match(/who\s+(?:follows|is.following|is.followed.by)\s+(.+)/i);
  if (followsMatch) {
    const target = followsMatch[1].trim();
    return {
      type: 'relationship_query',
      description: `Find who follows "${target}"`,
      confidence: 0.9,
      original: question,
      plan: {
        seedSearch: target,
        seedType: 'social_profile',
        hops: [
          { relationship: 'follows', direction: 'reverse', targetType: 'social_profile', label: 'followed_by' },
        ],
        maxResults: 100,
        includeIntermediate: false,
      },
    };
  }

  // ── Pattern 5: Who does X follow? ──
  const followingMatch = q.match(/(?:who|what|accounts)\s+(?:does|is|are)\s+(.+?)\s+(?:follow|following)\s*/i);
  if (followingMatch) {
    const target = followingMatch[1].trim();
    return {
      type: 'relationship_query',
      description: `Find who "${target}" follows`,
      confidence: 0.85,
      original: question,
      plan: {
        seedSearch: target,
        seedType: 'social_profile',
        hops: [
          { relationship: 'follows', direction: 'forward', targetType: 'social_profile', label: 'follows' },
        ],
        maxResults: 100,
        includeIntermediate: false,
      },
    };
  }

  // ── Pattern 6: "find posts about [topic]" | "show me content about [topic]" ──
  const topicMatch = q.match(/(?:find|show|get|list|search)\s+(?:posts|comments|content|articles|tweets)\s+(?:about|regarding|related.to|mentioning|tagged)\s+(.+)/i);
  if (topicMatch) {
    const topic = topicMatch[1].trim();
    return {
      type: 'entity_search',
      description: `Find posts/comments about "${topic}"`,
      confidence: 0.8,
      original: question,
      plan: {
        seedType: 'social_post',
        seedTags: [`topic:${topic.toLowerCase().replace(/\s+/g, '_')}`],
        seedSearch: topic,
        hops: [],
        maxResults: 50,
        includeIntermediate: false,
      },
    };
  }

  // ── Pattern 7: "liked posts about [topic]" / "who liked [content]" ──
  const likedMatch = q.match(/(?:who|users|people)\s+(?:liked|likes|favorited)\s+(?:posts\s+)?(?:about\s+)?(.+)/i);
  if (likedMatch) {
    const target = likedMatch[1].trim();
    return {
      type: 'relationship_query',
      description: `Find users who liked content about "${target}"`,
      confidence: 0.75,
      original: question,
      plan: {
        seedSearch: target,
        seedType: 'social_post',
        hops: [
          { relationship: 'liked', direction: 'reverse', targetType: 'social_profile', label: 'liked_by' },
        ],
        maxResults: 50,
        includeIntermediate: false,
      },
    };
  }

  // ── Pattern 8: "members of [group]" / "who is in [group]" ──
  const groupMatch = q.match(/(?:members?|who\s+(?:is|are)\s+(?:in|part.of|member.of))\s+(.+)/i);
  if (groupMatch) {
    const group = groupMatch[1].trim();
    return {
      type: 'relationship_query',
      description: `Find members of "${group}"`,
      confidence: 0.85,
      original: question,
      plan: {
        seedSearch: group,
        seedType: 'social_group',
        seedTags: ['social'],
        hops: [
          { relationship: 'member_of', direction: 'reverse', targetType: 'social_profile', label: 'member_of' },
        ],
        maxResults: 100,
        includeIntermediate: false,
      },
    };
  }

  // ── Pattern 9: "what does [person] think about [topic]" ──
  const thinkMatch = q.match(/what\s+(?:does|is)\s+(.+?)\s+(?:think|feel|believe|opinion)\s+(?:about|of|regarding)\s+(.+)/i);
  if (thinkMatch) {
    const person = thinkMatch[1].trim();
    const topic = thinkMatch[2].trim();
    return {
      type: 'stance_query',
      description: `Find "${person}" stance toward "${topic}"`,
      confidence: 0.75,
      original: question,
      plan: {
        seedSearch: person,
        seedType: 'social_profile',
        hops: [],
        stanceFilter: { target: topic, sentiment: 'positive', minConfidence: 0, minEvidence: 0 },
        maxResults: 10,
        includeIntermediate: false,
      },
    };
  }

  // ── Pattern 10: "people who shared [content]" ──
  const sharedMatch = q.match(/(?:who|users|people)\s+(?:shared|retweeted|reposted)\s+(.+)/i);
  if (sharedMatch) {
    const target = sharedMatch[1].trim();
    return {
      type: 'relationship_query',
      description: `Find users who shared content about "${target}"`,
      confidence: 0.75,
      original: question,
      plan: {
        seedSearch: target,
        seedType: 'social_post',
        hops: [
          { relationship: 'shared', direction: 'reverse', targetType: 'social_profile', label: 'shared_by' },
        ],
        maxResults: 50,
        includeIntermediate: false,
      },
    };
  }

  // ── Fallback: entity search ──
  return {
    type: 'entity_search',
    description: `Searching ontology for: "${q}"`,
    confidence: 0.3,
    original: question,
    plan: {
      seedSearch: q,
      hops: [],
      maxResults: 20,
      includeIntermediate: false,
    },
  };
}

// ──────────────────────────────────────────────────────────────
//  ANSWER SYNTHESIS
// ──────────────────────────────────────────────────────────────

/**
 * Synthesize a human-readable answer from graph traversal results.
 * Produces structured findings with citations to source entities.
 */
export function synthesizeAnswer(
  question: string,
  parsed: ParsedQuestion,
  results: GraphEntity[],
  paths: TraversalPath[],
  durationMs: number,
): GraphRAGAnswer {
  const findings: Finding[] = [];
  let dataSufficient = results.length > 0;

  if (results.length === 0) {
    return {
      answer: `I couldn't find any results matching your question. This could mean the data hasn't been ingested yet, or no entities match the criteria "${parsed.description}". Try running a connector to populate the ontology first.`,
      confidence: 0.9,
      findings: [],
      dataSufficient: false,
      warning: 'No results found — the ontology may not contain relevant data for this query',
      stats: { resultsFound: 0, hopsExecuted: parsed.plan.hops.length, durationMs },
    };
  }

  // Build findings from results
  for (const entity of results.slice(0, 15)) {
    const path = paths.find(p => p.entities[p.entities.length - 1]?.id === entity.id);

    let evidence = '';
    if (path) {
      evidence = path.explanation;
    }

    // Check for stance data
    const profiles = entity.properties?.stance_profiles;
    if (profiles) {
      for (const [target, profile] of Object.entries(profiles) as any) {
        if (profile.count?.total > 0) {
          findings.push({
            description: `"${entity.label}" feels ${profile.sentimentLabel} toward ${profile.target} (score: ${profile.score})`,
            type: 'stance',
            entityIds: [entity.id],
            evidence: `Based on ${profile.count.total} interactions (${profile.count.posts} posts, ${profile.count.comments} comments)`,
            relevance: Math.abs(profile.score) * profile.confidence,
          });
        }
      }
    }

    // Add entity as a finding
    findings.push({
      description: entity.label,
      type: 'entity',
      entityIds: [entity.id],
      evidence: evidence || `${entity.type} found in ontology`,
      relevance: 0.8,
    });
  }

  // Build the natural language answer
  const answerParts: string[] = [];
  const targetType = parsed.plan.targetType || parsed.plan.seedType || 'entity';

  answerParts.push(`Found **${results.length}** ${targetType.replace(/_/g, ' ')} matching your query.`);

  // Stance-specific summary
  if (parsed.plan.stanceFilter) {
    const { target, sentiment } = parsed.plan.stanceFilter;
    const stanceFindings = findings.filter(f => f.type === 'stance');
    const count = stanceFindings.length;

    if (count > 0) {
      answerParts.push(`\n\n**${count}** ${sentiment === 'negative' ? 'users who expressed negative views' : 'users who expressed positive views'} toward "${target}":`);
      for (const f of stanceFindings.slice(0, 10)) {
        answerParts.push(`\n- ${f.description} — ${f.evidence}`);
      }
    }
  }
  // Relationship-specific summary
  else if (parsed.type === 'relationship_query' || parsed.type === 'multi_hop' || parsed.type === 'network_query') {
    answerParts.push('\n\nResults:');
    for (const entity of results.slice(0, 10)) {
      const path = paths.find(p => p.entities[p.entities.length - 1]?.id === entity.id);
      const explanation = path?.explanation || '';
      answerParts.push(`\n- **${entity.label}** (${entity.type}) — ${explanation}`);
    }
  }
  // Entity search
  else {
    answerParts.push('\n\nMatching entities:');
    for (const entity of results.slice(0, 15)) {
      const tags = entity.tags.filter(t => t.startsWith('topic:') || t.startsWith('stance:')).join(', ');
      answerParts.push(`\n- **${entity.label}** (${entity.type})${tags ? ` — ${tags}` : ''}`);
    }
  }

  // Overspill note
  if (results.length > 15) {
    answerParts.push(`\n\n... and ${results.length - 15} more results (showing top 15).`);
  }

  // Evidence summary
  const totalEdges = paths.reduce((s, p) => s + p.edges.length, 0);
  answerParts.push(`\n\n---\n*Retrieved ${results.length} entities across ${paths.length} graph paths (${totalEdges} relationships traversed in ${durationMs}ms)*`);

  return {
    answer: answerParts.join(''),
    confidence: results.length > 0 ? 0.8 : 0.3,
    findings: findings.sort((a, b) => b.relevance - a.relevance).slice(0, 30),
    dataSufficient,
    stats: {
      resultsFound: results.length,
      hopsExecuted: parsed.plan.hops.length,
      durationMs,
    },
  };
}

// ──────────────────────────────────────────────────────────────
//  FULL PIPELINE
// ──────────────────────────────────────────────────────────────

/**
 * Full GraphRAG pipeline: parse → traverse → synthesize.
 */
export async function answerQuestion(question: string): Promise<GraphRAGAnswer> {
  const startTime = Date.now();

  // Step 1: Parse the question
  const parsed = parseQuestion(question);

  // Step 2: Execute the graph traversal
  const traversalResult = await executeGraphQuery(parsed.plan);

  // Step 3: Synthesize the answer
  const answer = synthesizeAnswer(
    question,
    parsed,
    traversalResult.results,
    traversalResult.paths,
    Date.now() - startTime,
  );

  return answer;
}
