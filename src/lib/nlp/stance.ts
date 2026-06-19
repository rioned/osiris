/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Target-Stance & Opinion Mining Engine
 *
 *  Aspect-based sentiment that scores how each person feels about
 *  a specific target (country, organisation, person, or topic)
 *  by aggregating the stance of their posts, comments, likes,
 *  and shares.
 *
 *  Produces per-entity opinion profiles — e.g. attitude toward
 *  "Rwanda": negative (0.82, from 14 posts / 9 comments) —
 *  that become first-class, filterable properties on the
 *  person/social_profile node.
 *
 *  Zero external dependencies — all lexicon and pattern matching
 *  is built in.
 * ═══════════════════════════════════════════════════════════════
 */

import { extractNamedEntities } from './pipeline';

// ──────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────

/** A single piece of evidence — one post/comment that expresses stance */
export interface StanceEvidence {
  /** The text that was analyzed */
  sourceText: string;
  /** Type of interaction: 'post', 'comment', 'like', 'share' */
  interactionType: 'post' | 'comment' | 'like' | 'share' | 'reply';
  /** Stance score -1 to +1 for this single instance */
  stance: number;
  /** ISO timestamp */
  date: string;
  /** Entity ID of the post/comment */
  entityId?: string;
  /** Platform */
  platform?: string;
}

/** Aggregate stance toward one target */
export interface StanceProfile {
  /** The target entity or topic name */
  target: string;
  /** Type of target */
  targetType: 'person' | 'organization' | 'location' | 'country' | 'topic';
  /** Aggregate stance: -1 (strongly negative) to +1 (strongly positive) */
  score: number;
  /** Magnitude: 0-1 how strong/committed the opinion is */
  magnitude: number;
  /** Confidence: 0-1 based on signal volume */
  confidence: number;
  /** Evidence counts by interaction type */
  count: {
    posts: number;
    comments: number;
    likes: number;
    shares: number;
    total: number;
  };
  /** Recent trend direction */
  trend: 'stable' | 'improving' | 'deteriorating';
  /** Tag for filtering: 'positive', 'negative', 'neutral', 'mixed' */
  sentimentLabel: 'positive' | 'negative' | 'neutral' | 'mixed';
  /** Recent evidence (latest 5) */
  recentEvidence: StanceEvidence[];
  /** Timestamp of last update */
  lastUpdated: string;
}

/** Full result of analyzing one text for stance */
export interface StanceAnalysisResult {
  /** Stance scores per target found in this text */
  stances: StanceEvidence[];
  /** All targets mentioned in the text */
  targets: string[];
  /** Targets that had detectable opinion signals */
  scoredTargets: string[];
}

/** Collection of stance profiles for one actor entity */
export interface ActorStanceCollection {
  /** Entity ID of the actor */
  actorId: string;
  /** Timestamp of the last update */
  lastUpdated: string;
  /** Per-target stance profiles */
  profiles: Record<string, StanceProfile>;
  /** Total interactions analyzed */
  totalInteractions: number;
}

// ──────────────────────────────────────────────────────────────
//  SENTIMENT LEXICON
// ──────────────────────────────────────────────────────────────

const POSITIVE_WORDS = new Set([
  'good', 'great', 'excellent', 'amazing', 'wonderful', 'fantastic',
  'brilliant', 'outstanding', 'superb', 'magnificent', 'splendid',
  'positive', 'favorable', 'beneficial', 'helpful', 'useful',
  'support', 'supports', 'supported', 'supporting', 'supporter',
  'agree', 'agrees', 'agreed', 'agreeing', 'approve', 'approved',
  'praise', 'praises', 'praised', 'praising', 'commend', 'commended',
  'admire', 'admires', 'admired', 'admiring', 'admirable',
  'appreciate', 'appreciates', 'appreciated', 'grateful',
  'love', 'loves', 'loved', 'loving', 'like', 'likes', 'liked',
  'enjoy', 'enjoys', 'enjoyed', 'welcome', 'welcomes', 'welcomed',
  'success', 'successful', 'succeed', 'succeeds', 'achievement',
  'progress', 'improve', 'improves', 'improved', 'improvement',
  'growth', 'growing', 'grow', 'strong', 'stronger', 'strength',
  'safe', 'safety', 'secure', 'security', 'stable', 'stability',
  'peace', 'peaceful', 'freedom', 'free', 'liberty',
  'innovation', 'innovative', 'pioneer', 'pioneering', 'leading',
  'efficient', 'effective', 'impressive', 'remarkable',
  'beautiful', 'lovely', 'charming', 'delightful', 'pleasure',
  'happy', 'happiness', 'joy', 'joyful', 'celebrate', 'celebrated',
  'thrilled', 'excited', 'exciting', 'inspired', 'inspiring',
  'hopeful', 'promising', 'bright', 'potential', 'opportunity',
  'fair', 'fairness', 'justice', 'just', 'righteous',
  'honest', 'honesty', 'transparent', 'transparency',
  'accountable', 'accountability', 'reliable', 'trustworthy',
  'respected', 'respectable', 'reputable', 'prestigious',
  'legendary', 'iconic', 'hero', 'heroic', 'champion',
  'best', 'better', 'perfect', 'flawless', 'ideal',
  'vibrant', 'thriving', 'booming', 'prosperous', 'prosperity',
  'robust', 'resilient', 'dynamic', 'advanced', 'cutting-edge',
  'generous', 'compassionate', 'caring', 'thoughtful', 'kind',
  'essential', 'critical', 'important', 'crucial', 'vital',
  'welcome', 'embrace', 'embraces', 'embraced', 'endorse', 'endorses',
  'backed', 'backing', 'boost', 'boosts', 'boosted', 'contribute',
  'win', 'wins', 'won', 'winning', 'victory', 'triumph',
  'milestone', 'breakthrough', 'landmark', 'historic',
]);

const NEGATIVE_WORDS = new Set([
  'bad', 'terrible', 'awful', 'horrible', 'dreadful', 'atrocious',
  'negative', 'unfavorable', 'harmful', 'damaging', 'detrimental',
  'oppose', 'opposes', 'opposed', 'opposing', 'opposition',
  'disagree', 'disagrees', 'disagreed', 'disapprove', 'disapproved',
  'criticize', 'criticizes', 'criticized', 'criticizing', 'criticism',
  'condemn', 'condemns', 'condemned', 'condemning', 'denounce',
  'hate', 'hates', 'hated', 'hating', 'hatred', 'loath', 'loathe',
  'despise', 'despises', 'despised', 'detest', 'detests', 'detested',
  'dislike', 'dislikes', 'disliked', 'resent', 'resents', 'resented',
  'fail', 'fails', 'failed', 'failing', 'failure', 'failures',
  'problem', 'problems', 'issue', 'issues', 'trouble', 'troubles',
  'worst', 'worse', 'poor', 'inferior', 'substandard', 'mediocre',
  'corrupt', 'corruption', 'corrupted', 'corrupts', 'corrupting', 'unjust', 'unfair', 'unfairness',
  'danger', 'dangerous', 'threat', 'threats', 'threaten', 'threatens',
  'risk', 'risks', 'risky', 'crisis', 'disaster', 'disastrous',
  'catastrophe', 'catastrophic', 'tragedy', 'tragic', 'calamity',
  'cancer', 'disease', 'plague', 'scourge', 'blight',
  'collapse', 'collapsed', 'collapsing', 'decline', 'declining',
  'damage', 'damages', 'damaged', 'damaging', 'destroy', 'destroys',
  'destroyed', 'destroying', 'destruction', 'devastate', 'devastated', 'devastating',
  'suffer', 'suffers', 'suffered', 'suffering', 'pain', 'painful',
  'crisis', 'emergency', 'catastrophe', 'catastrophic',
  'exploit', 'exploits', 'exploited', 'exploitation', 'abuse', 'abuses',
  'abused', 'abusive', 'violate', 'violates', 'violated', 'violation',
  'oppress', 'oppresses', 'oppressed', 'oppressing', 'oppression',
  'illegal', 'unlawful', 'criminal', 'crime', 'scandal', 'scandalous',
  'shame', 'shameful', 'disgrace', 'disgraceful', 'outrage', 'outrageous',
  'appalling', 'shocking', 'horrific', 'hideous', 'monstrous',
  'tyranny', 'tyrannical', 'dictator', 'dictatorship', 'oppression',
  'suppress', 'suppresses', 'suppressed', 'suppression',
  'censorship', 'censor', 'censored', 'propaganda', 'indoctrination',
  'fraud', 'fraudulent', 'fake', 'false', 'dishonest', 'deceit',
  'betray', 'betrays', 'betrayed', 'betrayal', 'treason', 'traitor',
  'weak', 'weakness', 'fragile', 'vulnerable', 'instability',
  'chaos', 'chaotic', 'turmoil', 'turmoil', 'unrest', 'unstable',
  'conflict', 'conflicts', 'war', 'warfare', 'violence', 'violent',
  'aggression', 'aggressive', 'invasion', 'invade', 'invaded',
  'sanction', 'sanctions', 'embargo', 'blockade', 'boycott',
  'crisis', 'panicked', 'panic', 'fear', 'fears', 'fearful', 'afraid',
  'worried', 'worry', 'anxiety', 'anxious', 'stress', 'stressful',
  'disappoint', 'disappoints', 'disappointed', 'disappointment',
  'frustrate', 'frustrates', 'frustrated', 'frustration',
  'anger', 'angry', 'fury', 'furious', 'rage', 'enrage', 'enraged',
  'resentment', 'bitter', 'bitterness', 'hostile', 'hostility',
  'enemy', 'enemies', 'adversary', 'foe', 'rival', 'rivalry',
  'toxic', 'poisonous', 'cancerous', 'rotten', 'decay', 'decaying',
]);

const INTENSIFIERS = new Set([
  'very', 'extremely', 'incredibly', 'absolutely', 'completely',
  'totally', 'utterly', 'highly', 'deeply', 'profoundly',
  'exceptionally', 'remarkably', 'extraordinarily', 'immensely',
  'vastly', 'greatly', 'severely', 'gravely', 'seriously',
  'particularly', 'especially', 'overwhelmingly',
]);

const NEGATORS = new Set([
  'not', "n't", "n’t", 'never', 'no', 'nor', 'neither',
  'nothing', 'nowhere', 'hardly', 'barely', 'scarcely',
  'without', 'cannot', "can't", "won't", "don't", "doesn't",
  "didn't", "isn't", "aren't", "wasn't", "weren't", "haven't",
  "hasn't", "hadn't", "couldn't", "shouldn't", "wouldn't",
  "mustn't", "needn't", 'nobody', 'none', 'never',
]);

// Target-specific stance patterns
// Each pattern maps a verb/preposition + target to a sentiment direction
const STANCE_PATTERNS: { pattern: RegExp; sentiment: number }[] = [
  // Strong support patterns
  { pattern: /(?:strongly\s+)?support(?:s|ed|ing)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/g, sentiment: 0.8 },
  { pattern: /(?:am|are|is)\s+(?:a\s+)?(?:strong|big|firm|staunch)\s+(?:supporter|advocate|ally)\s+(?:of|for)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.85 },
  { pattern: /stand(?:s|ing)?\s+(?:with|by|behind)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.75 },
  { pattern: /back(?:s|ed|ing)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.7 },
  { pattern: /fight(?:s|ing|ht)?\s+(?:for|alongside)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.7 },
  { pattern: /(?:vote|voted|voting)\s+(?:for|yes|in.favor)\s+(?:of\s+)?(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.75 },

  // Strong opposition patterns
  { pattern: /(?:strongly\s+)?oppos(?:e|es|ed|ing)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/g, sentiment: -0.8 },
  { pattern: /(?:am|are|is)\s+(?:against|opposed.to)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.7 },
  { pattern: /condemn(?:s|ed|ing)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.85 },
  { pattern: /denounc(?:e|es|ed|ing)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.8 },
  { pattern: /reject(?:s|ed|ing)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.75 },
  { pattern: /(?:vote|voted|voting)\s+(?:against|no)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.75 },
  { pattern: /protest(?:s|ed|ing)?\s+(?:against\s+)?(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.7 },
  { pattern: /boycott(?:s|ed|ing)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.7 },
  { pattern: /sanction(?:s|ed|ing)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.65 },

  // Blame / credit patterns
  { pattern: /(?:blame|blames|blamed|blaming)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.7 },
  { pattern: /credit(?:s|ed)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.7 },
  { pattern: /thank(?:s|ed)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.8 },
  { pattern: /praise(?:s|d)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.75 },
  { pattern: /criticiz(?:e|es|ed|ing)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.7 },
  { pattern: /attack(?:s|ed|ing)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.75 },
  { pattern: /defend(?:s|ed|ing)?\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.7 },

  // Affiliative patterns
  { pattern: /(?:member|members)\s+(?:of|in)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.5 },
  { pattern: /(?:work|works|worked|working)\s+(?:at|for|with)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.4 },
  { pattern: /(?:join|joins|joined|joining)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.5 },
  { pattern: /(?:ally|allied|allies)\s+(?:with|of)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: 0.6 },

  // Conflict / opposition implicit
  { pattern: /(?:war|battle|fight|conflict)\s+(?:against|with)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.6 },
  { pattern: /(?:leave|leaves|left|leaving)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.3 },
  { pattern: /(?:resign|resigns|resigned|resigning)\s+(?:from|as)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.3 },
  { pattern: /(?:flee|fled|fleeing)\s+(?:from\s+)?(?:the\s+)?([A-Z][a-zA-Z]+)/gi, sentiment: -0.5 },
];

// ──────────────────────────────────────────────────────────────
//  TARGET EXTRACTION
// ──────────────────────────────────────────────────────────────

/** Known country names and demonyms for high-confidence target identification */
const KNOWN_COUNTRIES = new Set([
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina',
  'armenia', 'australia', 'austria', 'azerbaijan', 'bahamas', 'bahrain',
  'bangladesh', 'barbados', 'belarus', 'belgium', 'belize', 'benin',
  'bhutan', 'bolivia', 'bosnia', 'botswana', 'brazil', 'brunei',
  'bulgaria', 'burkina', 'burundi', 'cambodia', 'cameroon', 'canada',
  'chad', 'chile', 'china', 'colombia', 'congo', 'croatia', 'cuba',
  'cyprus', 'czech', 'denmark', 'djibouti', 'dominican', 'ecuador',
  'egypt', 'salvador', 'england', 'eritrea', 'estonia', 'eswatini',
  'ethiopia', 'fiji', 'finland', 'france', 'gabon', 'gambia', 'georgia',
  'germany', 'ghana', 'greece', 'guatemala', 'guinea', 'guyana', 'haiti',
  'honduras', 'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq',
  'ireland', 'israel', 'italy', 'ivory', 'jamaica', 'japan', 'jordan',
  'kazakhstan', 'kenya', 'kiribati', 'kosovo', 'kuwait', 'kyrgyzstan',
  'laos', 'latvia', 'lebanon', 'lesotho', 'liberia', 'libya', 'liechtenstein',
  'lithuania', 'luxembourg', 'madagascar', 'malawi', 'malaysia', 'maldives',
  'mali', 'malta', 'marshall', 'mauritania', 'mauritius', 'mexico',
  'micronesia', 'moldova', 'monaco', 'mongolia', 'montenegro', 'morocco',
  'mozambique', 'myanmar', 'namibia', 'nauru', 'nepal', 'netherlands',
  'zealand', 'nicaragua', 'niger', 'nigeria', 'korea', 'macedonia',
  'norway', 'oman', 'pakistan', 'palau', 'palestine', 'panama', 'papua',
  'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar',
  'romania', 'russia', 'rwanda', 'st kitts', 'st lucia', 'st vincent',
  'samoa', 'marino', 'sao tome', 'arabia', 'scotland', 'senegal', 'serbia',
  'seychelles', 'sierra', 'singapore', 'slovakia', 'slovenia', 'solomon',
  'somalia', 'africa', 'sudan', 'suriname', 'sweden', 'switzerland',
  'syria', 'taiwan', 'tajikistan', 'tanzania', 'thailand', 'timor',
  'togo', 'tonga', 'trinidad', 'tunisia', 'turkey', 'turkmenistan',
  'tuvalu', 'uganda', 'ukraine', 'emirates', 'britain', 'kingdom',
  'states', 'uruguay', 'uzbekistan', 'vanuatu', 'vatican', 'venezuela',
  'vietnam', 'wales', 'yemen', 'zambia', 'zimbabwe',
]);

/** Prepositional stance triggers that link a sentiment word to a target */
function findTargetsInText(text: string): { name: string; type: string; start: number }[] {
  const targets: { name: string; type: string; start: number }[] = [];
  const seen = new Set<string>();

  // 1. Extract named entities from the NLP pipeline
  const entities = extractNamedEntities(text);
  for (const ent of entities) {
    if (ent.type === 'person' && ent.confidence > 0.5) {
      // Extract just the name without title
      const name = ent.text.replace(/^(?:Mr|Mrs|Ms|Dr|Prof|Sir|Capt|Sgt|Gen|Adm|Hon|Rev|Fr)\.?\s+/i, '').trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        targets.push({ name, type: 'person', start: ent.start });
      }
    }
    if (ent.type === 'organization' && ent.confidence > 0.4) {
      const name = ent.text;
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        targets.push({ name, type: 'organization', start: ent.start });
      }
    }
    if (ent.type === 'location' && ent.confidence > 0.4) {
      const name = ent.text;
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        targets.push({ name, type: 'location', start: ent.start });
      }
    }
    if (ent.type === 'hashtag') {
      const name = ent.text.replace('#', '');
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        targets.push({ name, type: 'topic', start: ent.start });
      }
    }
  }

  // 2. Check for known countries not captured by NER
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (KNOWN_COUNTRIES.has(word) && !seen.has(word)) {
      const name = words[i].replace(/[^a-zA-Z]/g, '');
      seen.add(word);
      let start = text.toLowerCase().indexOf(word);
      if (start >= 0) {
        targets.push({ name, type: 'country', start });
      }
    }
  }

  return targets;
}

// ──────────────────────────────────────────────────────────────
//  SENTIMENT SCORING
// ──────────────────────────────────────────────────────────────

/**
 * Score sentiment of text toward a specific target using
 * proximity-weighted lexicon matching and stance patterns.
 *
 * Returns a score from -1 (strongly negative) to +1 (strongly positive).
 */
function scoreSentimentTowardTarget(text: string, target: string): number {
  const lower = text.toLowerCase();
  const targetLower = target.toLowerCase();

  // 1. Check explicit stance patterns first (highest confidence)
  for (const sp of STANCE_PATTERNS) {
    sp.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = sp.pattern.exec(text)) !== null) {
      const matchedTarget = m[1].toLowerCase();
      // Check if the matched target matches
      if (matchedTarget.includes(targetLower) || targetLower.includes(matchedTarget)) {
        // Check for negation
        const beforeMatch = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
        const hasNegation = [...NEGATORS].some(n => beforeMatch.includes(n));
        return hasNegation ? -sp.sentiment : sp.sentiment;
      }
    }
  }

  // 2. Proximity-based sentiment: find target position, check nearby sentiment words
  const targetIdx = lower.indexOf(targetLower);
  if (targetIdx < 0) return 0;

  // Analyze windows around the target (forward and backward)
  const windowSize = 100;
  const start = Math.max(0, targetIdx - windowSize);
  const end = Math.min(text.length, targetIdx + targetLower.length + windowSize);
  const window = lower.slice(start, end);
  const windowWords = window.split(/\s+/).filter(w => w.length > 0);

  if (windowWords.length === 0) return 0;

  let positiveScore = 0;
  let negativeScore = 0;
  let negationActive = false;
  let intensifierActive = false;

  for (let i = 0; i < windowWords.length; i++) {
    const word = windowWords[i].replace(/[^a-z]/g, '');

    // Skip the target word itself
    if (word === targetLower) continue;

    // Check negation
    if (NEGATORS.has(word)) {
      negationActive = true;
      continue;
    }

    // Check intensifier
    if (INTENSIFIERS.has(word)) {
      intensifierActive = true;
      continue;
    }

    // Check sentiment
    const multiplier = intensifierActive ? 1.5 : 1.0;
    const finalMultiplier = negationActive ? -multiplier : multiplier;

    if (POSITIVE_WORDS.has(word)) {
      positiveScore += 1 * finalMultiplier;
      negationActive = false;
      intensifierActive = false;
    } else if (NEGATIVE_WORDS.has(word)) {
      negativeScore += 1 * finalMultiplier;
      negationActive = false;
      intensifierActive = false;
    } else {
      // Reset modifiers after a few words if no sentiment word found
      if (i > 0 && windowWords[i - 1].replace(/[^a-z]/g, '') === word) {
        // same word, skip
      }
      negationActive = false;
      intensifierActive = false;
    }
  }

  // Calculate net score
  const total = positiveScore - negativeScore;
  const maxPossible = Math.max(positiveScore, Math.abs(negativeScore));
  if (maxPossible === 0) return 0;

  const rawScore = total / maxPossible;
  // Clamp to -1..1
  return Math.max(-1, Math.min(1, rawScore));
}

/**
 * Detect if the text contains sarcasm indicators that should
 * invert or dampen the literal sentiment score.
 */
function detectSarcasm(text: string): number {
  let sarcasmScore = 0;

  // Sarcasm indicators
  if (/sarcasm|sarcastic|obviously|clearly|sure,\s+(Jan|Feb|Mar)/i.test(text)) sarcasmScore += 0.3;
  if (/yeah,\s+right|oh\s+(really|sure)|as\s+if/i.test(text)) sarcasmScore += 0.3;
  if (/"[^"]{5,}"\s+\-\s+said\s+no\s+one/i.test(text)) sarcasmScore += 0.4;
  if (/what\s+a\s+(great|wonderful|fantastic)\s+(idea|plan|success)/i.test(text)) sarcasmScore += 0.3;

  // Punctuation-based: excessive !!! or ??? suggests sarcasm/emphasis
  const exclExcess = (text.match(/!{2,}/g) || []).length;
  const qExcess = (text.match(/\?{2,}/g) || []).length;
  sarcasmScore += Math.min(0.3, (exclExcess + qExcess) * 0.1);

  return Math.min(1, sarcasmScore);
}

// ──────────────────────────────────────────────────────────────
//  MAIN ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * Analyze a single text for stance toward all detected targets.
 * Returns per-target stance scores.
 */
export function analyzeStance(
  text: string,
  interactionType: StanceEvidence['interactionType'] = 'post',
  date: string = new Date().toISOString(),
  entityId?: string,
  platform?: string,
): StanceAnalysisResult {
  if (!text || text.trim().length < 5) {
    return { stances: [], targets: [], scoredTargets: [] };
  }

  const targets = findTargetsInText(text);
  const targetNames = targets.map(t => t.name);
  if (targetNames.length === 0) {
    return { stances: [], targets: [], scoredTargets: [] };
  }

  // Deduplicate targets (keep the one with highest confidence type)
  const uniqueTargets = new Map<string, string>();
  for (const t of targets) {
    const current = uniqueTargets.get(t.name.toLowerCase());
    if (!current) {
      uniqueTargets.set(t.name.toLowerCase(), t.type);
    }
  }

  const sarcasmFactor = detectSarcasm(text);
  const scoredTargets: string[] = [];
  const evidences: StanceEvidence[] = [];

  for (const [targetName, targetType] of uniqueTargets) {
    let stance = scoreSentimentTowardTarget(text, targetName);

    // Apply sarcasm dampening: if sarcasm detected and sentiment is strong,
    // invert or dampen
    if (sarcasmFactor > 0.3 && Math.abs(stance) > 0.3) {
      // Strong sarcasm → likely ironic → invert
      stance = -stance * (1 - sarcasmFactor * 0.3);
    }

    // Only record if we have a detectable signal
    if (Math.abs(stance) > 0.05) {
      scoredTargets.push(targetName);
      evidences.push({
        sourceText: text.slice(0, 200),
        interactionType,
        stance: Math.round(stance * 100) / 100,
        date,
        entityId,
        platform,
      });
    }
  }

  return {
    stances: evidences,
    targets: targetNames,
    scoredTargets,
  };
}

// ──────────────────────────────────────────────────────────────
//  AGGREGATION
// ──────────────────────────────────────────────────────────────

/**
 * Interaction weight multipliers — how much each interaction
 * type counts toward aggregate stance.
 * Posts/comments (direct utterances) weigh more than likes/shares.
 */
const INTERACTION_WEIGHT: Record<string, number> = {
  post: 1.0,
  comment: 0.9,
  reply: 0.85,
  like: 0.3,
  share: 0.35,
};

/**
 * Merge a new stance evidence into an existing actor stance collection.
 */
export function mergeStanceEvidence(
  existing: ActorStanceCollection | null,
  actorId: string,
  evidence: StanceEvidence[],
): ActorStanceCollection {
  const now = new Date().toISOString();

  if (!existing) {
    // First-time: build from evidence
    const profiles: Record<string, StanceProfile> = {};
    let totalInteractions = 0;

    for (const ev of evidence) {
      const target = normalizeTargetName(ev.sourceText, ev.stance);
      // We need the actual target name — for first-time build, extract from evidence context
      // This is a simplified version; in practice, evidence comes with target context
      totalInteractions++;
    }

    return {
      actorId,
      lastUpdated: now,
      profiles: {},
      totalInteractions: 0,
    };
  }

  // Clone to avoid mutation
  const profiles = { ...existing.profiles };
  let totalInteractions = existing.totalInteractions;

  for (const ev of evidence) {
    // We need to associate this evidence with the correct target.
    // For mergeStanceEvidence to work properly, the caller must pass the
    // target name. We handle this in the integration function below.
    totalInteractions++;
  }

  return {
    actorId,
    lastUpdated: now,
    profiles,
    totalInteractions,
  };
}

/**
 * Update an actor's stance profile with new evidence toward a specific target.
 * This is the primary integration function called after a post/comment is created.
 *
 * @param existingProfiles The actor's existing stance profiles (from entity properties)
 * @param actorId The actor entity ID
 * @param target The target name (e.g. "Rwanda", "Microsoft")
 * @param targetType The target type
 * @param newEvidence Single stance evidence from a new post/comment
 * @returns Updated profiles record
 */
export function updateStanceProfile(
  existingProfiles: Record<string, StanceProfile> | null,
  actorId: string,
  target: string,
  targetType: StanceProfile['targetType'],
  newEvidence: StanceEvidence,
): Record<string, StanceProfile> {
  const profiles = existingProfiles ? { ...existingProfiles } : {};
  const now = new Date().toISOString();
  const targetLower = target.toLowerCase().trim();

  const existing = profiles[targetLower];
  const weight = INTERACTION_WEIGHT[newEvidence.interactionType] || 0.5;

  if (!existing) {
    // First evidence for this target
    profiles[targetLower] = {
      target: target,
      targetType,
      score: newEvidence.stance,
      magnitude: Math.abs(newEvidence.stance),
      confidence: 0.3, // Low confidence with 1 data point
      count: {
        posts: newEvidence.interactionType === 'post' ? 1 : 0,
        comments: newEvidence.interactionType === 'comment' ? 1 : 0,
        likes: newEvidence.interactionType === 'like' ? 1 : 0,
        shares: newEvidence.interactionType === 'share' ? 1 : 0,
        total: 1,
      },
      trend: 'stable',
      sentimentLabel: stanceToLabel(newEvidence.stance),
      recentEvidence: [newEvidence],
      lastUpdated: now,
    };
  } else {
    // Accumulate
    const count = { ...existing.count };
    count.posts += newEvidence.interactionType === 'post' ? 1 : 0;
    count.comments += newEvidence.interactionType === 'comment' ? 1 : 0;
    count.likes += newEvidence.interactionType === 'like' ? 1 : 0;
    count.shares += newEvidence.interactionType === 'share' ? 1 : 0;
    count.total++;

    // Weighted moving average: new evidence has weight, old history has (1-weight/count_adjust)
    const totalWeight = Math.min(1, count.total * 0.15); // More evidence = more stable
    const oldWeight = 1 - totalWeight;
    const newScore = existing.score * oldWeight + newEvidence.stance * totalWeight;

    // Calculate trend: compare recent evidence average to overall
    const recentEvidence = [newEvidence, ...existing.recentEvidence].slice(0, 5);
    const recentAvg = recentEvidence.reduce((s, e) => s + e.stance, 0) / recentEvidence.length;
    const trendDiff = recentAvg - existing.score;

    const trend: 'stable' | 'improving' | 'deteriorating' =
      Math.abs(trendDiff) < 0.1 ? 'stable' :
      trendDiff > 0 ? 'improving' : 'deteriorating';

    // Confidence increases with more signals
    const newConfidence = Math.min(1, existing.confidence + 0.15);

    profiles[targetLower] = {
      ...existing,
      score: Math.round(newScore * 100) / 100,
      magnitude: Math.abs(newScore),
      confidence: Math.round(newConfidence * 100) / 100,
      count,
      trend,
      sentimentLabel: stanceToLabel(newScore),
      recentEvidence,
      lastUpdated: now,
    };
  }

  return profiles;
}

// ──────────────────────────────────────────────────────────────
//  STANCE PROPERTIES FOR ENTITY STORAGE
// ──────────────────────────────────────────────────────────────

/**
 * Convert stance profiles into entity properties suitable for
 * storage on a person/social_profile node.
 *
 * Stores:
 *   - stance_profiles: Record of target → StanceProfile (JSON)
 *   - stance_updated_at: timestamp
 *   - stance_targets: string[] of all targets (for filtering)
 *   - stance_tags: string[] for tag-based filtering
 */
export function stanceProfilesToProperties(
  profiles: Record<string, StanceProfile>,
): Record<string, any> {
  const targets = Object.keys(profiles);
  const tags: string[] = [];

  for (const [target, profile] of Object.entries(profiles)) {
    if (profile.count.total > 0) {
      const safeTarget = target.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      tags.push(`stance:${safeTarget}:${profile.sentimentLabel}`);
      tags.push(`stance:${safeTarget}:${profile.trend}`);
      if (profile.confidence > 0.5) {
        tags.push(`stance:${safeTarget}:high_confidence`);
      }
    }
  }

  return {
    stance_profiles: profiles,
    stance_updated_at: new Date().toISOString(),
    stance_targets: targets,
    stance_tags: tags,
  };
}

// ──────────────────────────────────────────────────────────────
//  HIGH-LEVEL INTEGRATION API
// ──────────────────────────────────────────────────────────────

export interface StanceIntegrationResult {
  /** Targets that were scored */
  scoredTargets: string[];
  /** The stance evidence generated */
  evidence: StanceEvidence[];
  /** The updated stance profiles (merged into existing) */
  updatedProfiles: Record<string, StanceProfile>;
  /** Properties to merge into the entity */
  entityProperties: Record<string, any>;
  /** Tags to add to the entity */
  tags: string[];
}

/**
 * Full integration function: given the actor entity ID, the text of
 * a post/comment, and the interaction type, run stance analysis,
 * merge with existing profiles, and produce updated entity properties.
 *
 * Call this after creating a social_post entity with text content.
 */
export function runStanceIntegration(
  actorId: string,
  text: string,
  interactionType: StanceEvidence['interactionType'],
  date: string,
  existingStanceProfiles: Record<string, StanceProfile> | null,
  entityId?: string,
  platform?: string,
): StanceIntegrationResult {
  // 1. Analyze stance
  const analysis = analyzeStance(text, interactionType, date, entityId, platform);

  // 2. If no scored targets, nothing to update
  if (analysis.scoredTargets.length === 0) {
    return {
      scoredTargets: [],
      evidence: [],
      updatedProfiles: existingStanceProfiles || {},
      entityProperties: {},
      tags: [],
    };
  }

  // 3. Determine target types for each scored target
  const targets = findTargetsInText(text);
  const targetTypeMap = new Map<string, string>();
  for (const t of targets) {
    if (!targetTypeMap.has(t.name.toLowerCase())) {
      targetTypeMap.set(t.name.toLowerCase(), t.type);
    }
  }

  // 4. Merge each evidence into stance profiles
  let profiles = existingStanceProfiles ? { ...existingStanceProfiles } : {};

  for (const evidence of analysis.stances) {
    // Find the actual target name for this evidence
    // We need to map the evidence back to a target.
    // Since evidence.stance is the score, and we know the targets from
    // analysis.scoredTargets, we need to associate each evidence with a target.
    // The evidence doesn't carry the target name directly — we need to match
    // using the source text. Let's find which target(s) in this text match.
    const matchedTargets = analysis.scoredTargets.filter(t =>
      evidence.sourceText.toLowerCase().includes(t.toLowerCase()),
    );

    for (const targetName of matchedTargets) {
      const targetType = (targetTypeMap.get(targetName.toLowerCase()) as StanceProfile['targetType']) || 'topic';
      profiles = updateStanceProfile(
        profiles,
        actorId,
        targetName,
        targetType,
        evidence,
      );
    }
  }

  // 5. Build entity properties
  const props = stanceProfilesToProperties(profiles);

  return {
    scoredTargets: analysis.scoredTargets,
    evidence: analysis.stances,
    updatedProfiles: profiles,
    entityProperties: props,
    tags: props.stance_tags || [],
  };
}

// ──────────────────────────────────────────────────────────────
//  QUERY: Get stance toward a specific target across an actor
// ──────────────────────────────────────────────────────────────

/**
 * Get the stance profile for a specific target.
 */
export function getStanceToward(
  profiles: Record<string, StanceProfile> | null,
  target: string,
): StanceProfile | null {
  if (!profiles) return null;
  const key = target.toLowerCase().trim();
  return profiles[key] || null;
}

/**
 * List all targets an actor has expressed stance about.
 */
export function listStanceTargets(
  profiles: Record<string, StanceProfile> | null,
): { target: string; type: string; score: number; label: string }[] {
  if (!profiles) return [];
  return Object.entries(profiles)
    .filter(([_, p]) => p.count.total > 0)
    .map(([key, p]) => ({
      target: p.target,
      type: p.targetType,
      score: p.score,
      label: p.sentimentLabel,
    }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

function normalizeTargetName(text: string, _stance: number): string {
  // Extract the most relevant target from text context
  // Used as fallback when merging raw evidence
  const targets = findTargetsInText(text);
  return targets.length > 0 ? targets[0].name : 'unknown';
}

function stanceToLabel(score: number): 'positive' | 'negative' | 'neutral' | 'mixed' {
  if (score > 0.3) return 'positive';
  if (score < -0.3) return 'negative';
  if (Math.abs(score) < 0.05) return 'neutral';
  return 'mixed';
}
