/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — AI Integration Hub
 *
 *  Wires DeepSeek AI into Identity Resolution, Connectors, and
 *  Graph Analytics — providing semantic entity matching, smart
 *  feed parsing, and natural-language graph insights.
 *
 *  Reuses the existing callDeepSeek pattern from the AI engine
 *  so all AI calls go through the same API key management.
 * ═══════════════════════════════════════════════════════════════
 */

import { PersonalEntity, PersonalRelationship } from './personal-ontology';

// ── AI Client ────────────────────────────────────────────────

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY_1 || process.env.DEEPSEEK_API_KEY || '';
  if (key) return key;
  for (const k of Object.keys(process.env)) {
    if (k.toLowerCase().includes('deepseek') && process.env[k]) return process.env[k]!;
  }
  return '';
}

async function callAI(system: string, user: string, maxTokens = 2048): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) return '';
  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch {
    return '';
  }
}

// ═════════════════════════════════════════════════════════════
//  1. AI-POWERED IDENTITY RESOLUTION
// ═════════════════════════════════════════════════════════════

/**
 * AI-powered entity matching: takes two entities and asks the AI
 * whether they represent the same real-world person, explaining why.
 * Returns a confidence score 0-1 with reasoning.
 */
export async function aiResolveIdentity(
  a: PersonalEntity,
  b: PersonalEntity,
): Promise<{ score: number; reason: string; signals: string[] } | null> {
  const systemPrompt = `You are an OSIRIS identity resolution specialist. Your job is to determine whether two data records represent the SAME real person. 

Consider these signals:
- Name similarity (including nicknames, middle names, initials)
- Shared identifiers (email, phone, username)
- Profile descriptions and bios
- Location / city overlap
- Occupation / industry match
- Profile photo URLs

Return ONLY a valid JSON object with:
{
  "score": 0.0-1.0,
  "samePerson": true|false,
  "reason": "brief explanation",
  "signals": ["signal description 1", "signal description 2"]
}`;

  const userPrompt = `Compare these two entities and determine if they represent the same person:

ENTITY A:
  Type: ${a.type}
  Label: ${a.label}
  Description: ${a.description || '(none)'}
  Properties: ${JSON.stringify(a.properties || {}, null, 2)}
  Tags: ${(a.tags || []).join(', ')}
  Source: ${a.source}

ENTITY B:
  Type: ${b.type}
  Label: ${b.label}
  Description: ${b.description || '(none)'}
  Properties: ${JSON.stringify(b.properties || {}, null, 2)}
  Tags: ${(b.tags || []).join(', ')}
  Source: ${b.source}

Return ONLY the JSON.`;

  const response = await callAI(systemPrompt, userPrompt);
  if (!response) return null;

  try {
    const cleaned = response.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      score: Math.min(1, Math.max(0, parsed.score || 0)),
      reason: parsed.reason || '',
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
    };
  } catch {
    return null;
  }
}

/**
 * AI-powered batch identity resolution: analyze all candidate pairs
 * to find which ones are likely the same person. Returns enhanced
 * scores for pairs that pass AI validation.
 */
export async function aiBatchResolveIdentities(
  candidates: { a: PersonalEntity; b: PersonalEntity; ruleScore: number }[],
): Promise<{ aId: string; bId: string; aiScore: number; reason: string }[]> {
  const results: { aId: string; bId: string; aiScore: number; reason: string }[] = [];

  // Process in batches of 5 to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < candidates.length && i < 20; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const batchPromises = batch.map(async (c) => {
      const aiResult = await aiResolveIdentity(c.a, c.b);
      if (aiResult && aiResult.score > 0.3) {
        return { aId: c.a.id, bId: c.b.id, aiScore: aiResult.score, reason: aiResult.reason };
      }
      return null;
    });
    const batchResults = await Promise.all(batchPromises);
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  return results;
}

// ═════════════════════════════════════════════════════════════
//  2. AI-POWERED CONNECTOR FEED PARSING
// ═════════════════════════════════════════════════════════════

export interface AIParsedEntity {
  type: string;
  label: string;
  description?: string;
  properties: Record<string, any>;
  tags: string[];
}

export interface AIParsedRelationship {
  sourceLabel: string;
  targetLabel: string;
  label: string;
  strength: number;
}

export interface AIParseResult {
  entities: AIParsedEntity[];
  relationships: AIParsedRelationship[];
  summary: string;
}

/**
 * AI-powered feed parsing: takes raw text from any connector
 * and extracts structured entities + relationships using AI.
 */
export async function aiParseFeed(
  rawText: string,
  source: string,
  fileType: string = 'text',
): Promise<AIParseResult> {
  const systemPrompt = `You are OSIRIS Connector AI. Parse the following raw ${source} data and extract:

1. **ENTITIES** — Every person, social profile, organization, place, event, or topic mentioned
2. **RELATIONSHIPS** — How entities connect (follows, works_at, member_of, located_at, mentioned_in, etc.)

Entity types: person, social_profile, organization, place, event, social_post, social_comment, social_group

For each entity provide: type, label, description, properties (platform, url, text, bio, etc.), tags
For each relationship provide: sourceLabel, targetLabel, label (relationship type), strength (0-1)

Return ONLY valid JSON:
{
  "entities": [...],
  "relationships": [...],
  "summary": "Brief summary of what was extracted"
}`;

  const userPrompt = `## SOURCE: ${source}
## TYPE: ${fileType}
## DATA:
${rawText.slice(0, 15000)}

Extract all entities and relationships. Return ONLY JSON.`;

  const response = await callAI(systemPrompt, userPrompt, 4096);
  if (!response) {
    return { entities: [], relationships: [], summary: 'AI unavailable' };
  }

  try {
    const cleaned = response.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      summary: parsed.summary || `Extracted ${Array.isArray(parsed.entities) ? parsed.entities.length : 0} entities`,
    };
  } catch {
    return { entities: [], relationships: [], summary: 'Failed to parse AI response' };
  }
}

// ═════════════════════════════════════════════════════════════
//  3. AI-POWERED GRAPH ANALYTICS INSIGHTS
// ═════════════════════════════════════════════════════════════

export interface AIGraphInsight {
  type: 'community' | 'influencer' | 'bridge' | 'anomaly' | 'trend' | 'recommendation';
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  entities: string[];
}

/**
 * AI-powered graph analysis: takes graph analytics results and
 * generates human-readable insights about communities, influencers,
 * bridges, and patterns.
 */
export async function aiAnalyzeGraph(
  communityData: { index: number; size: number; label: string }[],
  influencerData: { id: string; label: string; score: number }[],
  bridgeData: { entityId: string; entityLabel: string; bridgedCommunities: number[] }[],
  stanceData: Record<string, { positive: number; negative: number; total: number }>,
): Promise<AIGraphInsight[]> {
  const systemPrompt = `You are OSIRIS Graph Analyst AI. Analyze the graph data and produce actionable intelligence insights.

For each insight, provide:
- type: community|influencer|bridge|anomaly|trend|recommendation
- title: Short headline
- description: 2-3 sentence analysis
- severity: info|warning|critical
- entities: entity IDs involved

Return ONLY a JSON array of insights.`;

  const userPrompt = `## COMMUNITIES (${communityData.length} total):
${communityData.map(c => `  [${c.index}] ${c.label} (${c.size} members)`).join('\n')}

## TOP INFLUENCERS (${influencerData.length} total):
${influencerData.map(i => `  ${i.label}: score=${i.score.toFixed(3)}`).join('\n')}

## BRIDGE ACCOUNTS (${bridgeData.length} total):
${bridgeData.map(b => `  ${b.entityLabel} bridges communities: ${b.bridgedCommunities.join(',')}`).join('\n')}

## STANCE TARGETS:
${Object.entries(stanceData).map(([target, d]) =>
  `  ${target}: ${d.positive} positive, ${d.negative} negative (${d.total} total)`
).join('\n')}

Analyze the graph structure and provide intelligence insights. Return ONLY a valid JSON array.`;

  const response = await callAI(systemPrompt, userPrompt, 4096);
  if (!response) return [];

  try {
    const cleaned = response.replace(/```json/g, '').replace(/```/g, '').trim();
    // Try to extract JSON array
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(arrMatch ? arrMatch[0] : cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Generate a natural-language narrative about what's happening
 * in the graph — combining community shifts, influencer movements,
 * and stance trends.
 */
export async function aiGenerateGraphNarrative(
  analysisSummary: string,
): Promise<string> {
  const systemPrompt = `You are OSIRIS Narrative Analyst AI. Given graph analytics data, produce a concise intelligence narrative (3-5 paragraphs) covering:
1. Key communities and their characteristics
2. Top influencers and their roles
3. Notable bridges or connections
4. Stance patterns and opinion clusters
5. Any anomalies or patterns of interest

Write in a professional intelligence briefing style.`;

  const response = await callAI(systemPrompt, `## GRAPH ANALYSIS DATA:\n${analysisSummary.slice(0, 8000)}\n\nGenerate an intelligence narrative.`, 2048);
  return response || 'Narrative generation unavailable';
}

// ═════════════════════════════════════════════════════════════
//  EXPORT
// ═════════════════════════════════════════════════════════════

export const aiIntegration = {
  resolveIdentity: aiResolveIdentity,
  batchResolveIdentities: aiBatchResolveIdentities,
  parseFeed: aiParseFeed,
  analyzeGraph: aiAnalyzeGraph,
  generateGraphNarrative: aiGenerateGraphNarrative,
};
