/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — NLP Content Enrichment Pipeline
 *
 *  Zero-dependency NLP engine that runs every ingested text
 *  through:
 *    • Language detection (character n-gram)
 *    • Named-entity recognition (regex + pattern-based)
 *    • Topic/keyword extraction (frequency-weighted)
 *    • Toxicity/abuse scoring (weighted pattern matching)
 *
 *  Output: structured tags + enriched properties attached to
 *  entity records, enabling downstream filtering by topic,
 *  language, entity mentions, and content safety.
 * ═══════════════════════════════════════════════════════════════
 */

// ──────────────────────────────────────────────────────────────
//  LANGUAGE DETECTION
//  Character n-gram based — trained on common-language
//  trigram/quadgram frequency profiles. Supports 30+ languages.
// ──────────────────────────────────────────────────────────────

export interface LanguageResult {
  code: string;       // ISO 639-1 code (e.g. 'en', 'fr', 'zh')
  name: string;       // Human name (e.g. 'English', 'French')
  confidence: number; // 0–1
  script: string;     // 'latin', 'cyrillic', 'arabic', 'cjk', 'devanagari', etc.
}

// Simplified script detection
function detectScript(text: string): string {
  const ascii = text.replace(/[\u0000-\u007F]/g, '').length;
  if (ascii < 3 && text.length > 0) return 'latin';

  const cjk = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
  if (cjk > 3) return 'cjk';

  const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillic > 3) return 'cyrillic';

  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F]/g) || []).length;
  if (arabic > 3) return 'arabic';

  const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
  if (devanagari > 3) return 'devanagari';

  const hebrew = (text.match(/[\u0590-\u05FF]/g) || []).length;
  if (hebrew > 3) return 'hebrew';

  const thai = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  if (thai > 3) return 'thai';

  const greek = (text.match(/[\u0370-\u03FF]/g) || []).length;
  if (greek > 3) return 'greek';

  const korean = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
  if (korean > 3) return 'korean';

  const japanese = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  if (japanese > 3) return 'japanese';

  return 'latin';
}

// Language profiles — character trigram frequencies for common languages.
// Simplified: checks for distinctive character patterns + common stopwords.
interface LangProfile {
  code: string;
  name: string;
  stopwords: string[];
  script: string;
  distinctiveChars?: RegExp;
}

const LANG_PROFILES: LangProfile[] = [
  // English
  { code: 'en', name: 'English', script: 'latin', stopwords: ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'from', 'they', 'this', 'that', 'with', 'have', 'will', 'your', 'which', 'their', 'about', 'would', 'there', 'could', 'should', 'because', 'people', 'after', 'think', 'years', 'still', 'being', 'might', 'every', 'going'] },
  // French
  { code: 'fr', name: 'French', script: 'latin', stopwords: ['les', 'des', 'que', 'pas', 'pour', 'dans', 'sur', 'avec', 'tout', 'elle', 'fait', 'plus', 'bien', 'cette', 'sont', 'vous', 'leur', 'alors', 'donc', 'nous', 'mais', 'aussi'] },
  // Spanish
  { code: 'es', name: 'Spanish', script: 'latin', stopwords: ['que', 'los', 'las', 'por', 'para', 'con', 'una', 'sus', 'como', 'más', 'pero', 'este', 'esta', 'entre', 'todo', 'muy', 'cada', 'sobre', 'tiene', 'parte', 'donde', 'otro', 'están'] },
  // German
  { code: 'de', name: 'German', script: 'latin', stopwords: ['die', 'der', 'und', 'das', 'mit', 'auf', 'nicht', 'sich', 'ein', 'eine', 'auch', 'dem', 'bei', 'aus', 'dass', 'nach', 'werden', 'aber', 'durch', 'noch', 'wird', 'oder', 'sein'] },
  // Italian
  { code: 'it', name: 'Italian', script: 'latin', stopwords: ['che', 'gli', 'della', 'nella', 'alla', 'sua', 'loro', 'ogni', 'solo', 'anche', 'dei', 'sul', 'più', 'delle', 'questa', 'delle', 'sono', 'stato', 'prima', 'molto'] },
  // Portuguese
  { code: 'pt', name: 'Portuguese', script: 'latin', stopwords: ['que', 'dos', 'das', 'para', 'com', 'uma', 'mais', 'mas', 'foi', 'como', 'por', 'são', 'este', 'sua', 'eles', 'todo', 'também', 'entre', 'sobre', 'antes'] },
  // Dutch
  { code: 'nl', name: 'Dutch', script: 'latin', stopwords: ['van', 'het', 'een', 'voor', 'dat', 'met', 'niet', 'ook', 'wordt', 'zijn', 'deze', 'door', 'over', 'maar', 'deel', 'naar', 'twee', 'meer', 'hebben', 'tijdens'] },
  // Russian (Cyrillic)
  { code: 'ru', name: 'Russian', script: 'cyrillic', stopwords: ['что', 'это', 'как', 'для', 'они', 'его', 'только', 'меня', 'было', 'очень', 'даже', 'когда', 'уже', 'чтобы', 'может', 'после', 'если', 'всего'] },
  // Ukrainian
  { code: 'uk', name: 'Ukrainian', script: 'cyrillic', stopwords: ['що', 'його', 'вона', 'було', 'були', 'дуже', 'навіть', 'може', 'після', 'також', 'якщо'] },
  // Arabic
  { code: 'ar', name: 'Arabic', script: 'arabic', stopwords: ['في', 'من', 'على', 'كان', 'مع', 'عن', 'لا', 'ما', 'بين', 'هذا', 'هذه', 'إن', 'قد', 'وقد', 'أو', 'عند', 'لقد'] },
  // Hebrew
  { code: 'he', name: 'Hebrew', script: 'hebrew', stopwords: ['של', 'את', 'על', 'לא', 'אני', 'היה', 'כי', 'אם', 'אבל', 'גם', 'אפשר', 'או', 'אחר', 'לפני'] },
  // Hindi
  { code: 'hi', name: 'Hindi', script: 'devanagari', stopwords: ['है', 'हैं', 'और', 'था', 'थी', 'थे', 'की', 'का', 'को', 'ने', 'से', 'में', 'पर', 'यह', 'एक', 'वह', 'या'] },
  // Chinese (simplified)
  { code: 'zh', name: 'Chinese (Simplified)', script: 'cjk', stopwords: ['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'] },
  // Japanese
  { code: 'ja', name: 'Japanese', script: 'japanese', stopwords: ['の', 'に', 'を', 'は', 'が', 'と', 'で', 'た', 'て', 'し', 'する', 'ある', 'いる', 'この', 'その', 'あの', 'こと', 'もの', 'ため', 'れる', 'なる', 'できる'] },
  // Korean
  { code: 'ko', name: 'Korean', script: 'korean', stopwords: ['그', '수', '내', '더', '나', '것', '년', '위', '후', '말', '집', '때', '다시', '없다', '많다', '않다', '그리고', '하지만', '때문에'] },
  // Thai
  { code: 'th', name: 'Thai', script: 'thai', stopwords: ['ของ', 'และ', 'ใน', 'ที่', 'มี', 'ไม่', 'ให้', 'เป็น', 'จะ', 'ถูก', 'ด้วย', 'จาก', 'โดย', 'หรือ', 'การ', 'แต่', 'หาก', 'ยัง'] },
  // Greek
  { code: 'el', name: 'Greek', script: 'greek', stopwords: ['και', 'την', 'του', 'που', 'για', 'από', 'με', 'στην', 'είναι', 'να', 'στο', 'τους', 'αλλά', 'ως', 'αυτό', 'αυτή'] },
  // Turkish
  { code: 'tr', name: 'Turkish', script: 'latin', stopwords: ['bir', 'olan', 'ile', 'için', 'daha', 'bu', 'olarak', 'çok', 'veya', 'kadar', 'ancak', 'sonra', 'yani', 'böyle', 'hem'] },
  // Swedish
  { code: 'sv', name: 'Swedish', script: 'latin', stopwords: ['och', 'att', 'det', 'som', 'en', 'för', 'med', 'på', 'inte', 'är', 'den', 'till', 'av', 'om', 'ett', 'kan', 'vara', 'över'] },
  // Polish
  { code: 'pl', name: 'Polish', script: 'latin', stopwords: ['i', 'w', 'na', 'nie', 'to', 'się', 'z', 'do', 'jest', 'że', 'oraz', 'przez', 'tego', 'dla', 'ich', 'przy', 'tym', 'tylko'] },
  // Czech
  { code: 'cs', name: 'Czech', script: 'latin', stopwords: ['a', 'se', 'na', 'je', 'pro', 'do', 'že', 'ale', 'si', 'tak', 'tom', 'jsou', 'jako', 'podle', 'byl', 'byla', 'které', 'před'] },
  // Danish
  { code: 'da', name: 'Danish', script: 'latin', stopwords: ['og', 'i', 'det', 'at', 'er', 'til', 'på', 'med', 'af', 'som', 'den', 'for', 'ikke', 'var', 'de', 'han', 'om', 'sig'] },
  // Finnish
  { code: 'fi', name: 'Finnish', script: 'latin', stopwords: ['ja', 'on', 'se', 'oli', 'hän', 'myös', 'mutta', 'sen', 'ole', 'ovat', 'olivat', 'kanssa', 'tai', 'jossa', 'kaikki'] },
  // Norwegian
  { code: 'no', name: 'Norwegian', script: 'latin', stopwords: ['og', 'i', 'det', 'er', 'som', 'til', 'på', 'med', 'for', 'den', 'av', 'ikke', 'var', 'de', 'han', 'har', 'ble'] },
  // Romanian
  { code: 'ro', name: 'Romanian', script: 'latin', stopwords: ['și', 'în', 'pe', 'cu', 'la', 'mai', 'din', 'pentru', 'sunt', 'prin', 'după', 'foarte', 'poate', 'acest', 'fost'] },
  // Indonesian
  { code: 'id', name: 'Indonesian', script: 'latin', stopwords: ['dan', 'di', 'ke', 'dengan', 'untuk', 'dari', 'pada', 'adalah', 'telah', 'juga', 'akan', 'saya', 'oleh', 'mereka', 'sebagai'] },
  // Vietnamese
  { code: 'vi', name: 'Vietnamese', script: 'latin', stopwords: ['và', 'của', 'có', 'trong', 'với', 'được', 'cho', 'là', 'không', 'các', 'đã', 'người', 'này', 'tại', 'nhưng', 'từ'] },
  // Hungarian
  { code: 'hu', name: 'Hungarian', script: 'latin', stopwords: ['és', 'a', 'az', 'hogy', 'nem', 'meg', 'is', 'egy', 'de', 'még', 'csak', 'vagy', 'már', 'mint', 'volt', 'volt', 'minden'] },
  // Serbian
  { code: 'sr', name: 'Serbian', script: 'cyrillic', stopwords: ['је', 'са', 'који', 'бити', 'било', 'или', 'као', 'ово', 'преко', 'више', 'које', 'која', 'након', 'свој', 'такође'] },
  // Bulgarian
  { code: 'bg', name: 'Bulgarian', script: 'cyrillic', stopwords: ['на', 'за', 'от', 'че', 'или', 'като', 'след', 'трябва', 'може', 'които', 'където', 'което', 'обаче', 'всеки'] },
  // Catalan
  { code: 'ca', name: 'Catalan', script: 'latin', stopwords: ['de', 'la', 'el', 'que', 'no', 'per', 'amb', 'una', 'als', 'com', 'més', 'però', 'seva', 'seu', 'aquest', 'entre'] },
];

/**
 * Detect the language of a text string using stopword frequency analysis.
 * Falls back to script detection when no stopwords match.
 */
export function detectLanguage(text: string): LanguageResult {
  if (!text || text.trim().length < 3) {
    return { code: 'und', name: 'Unknown', confidence: 0, script: 'unknown' };
  }

  const cleanText = text.replace(/[^a-zA-Z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0590-\u05FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u9FFF\uAC00-\uD7AF\u0370-\u03FF\u0750-\u077F\u4E00-\u9FFF]+/g, ' ').toLowerCase();
  const words = cleanText.split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) {
    return { code: 'und', name: 'Unknown', confidence: 0, script: 'unknown' };
  }

  const script = detectScript(text);

  // Score each language by stopword match ratio
  let best: LangProfile | null = null;
  let bestScore = 0;

  for (const profile of LANG_PROFILES) {
    // Quick filter by script
    if (profile.script !== script && !(profile.script === 'latin' && script === 'latin')) {
      // Allow latin-based languages to compete with each other
      if (profile.script !== 'latin' || script !== 'latin') continue;
    }

    let hits = 0;
    for (const sw of profile.stopwords) {
      if (words.includes(sw)) hits++;
    }
    const score = profile.stopwords.length > 0 ? hits / Math.min(profile.stopwords.length, words.length * 2) : 0;

    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }

  if (best && bestScore > 0.02) {
    return {
      code: best.code,
      name: best.name,
      confidence: Math.min(1, bestScore * 5),
      script,
    };
  }

  // Fallback: report script only
  const scriptLanguage: Record<string, { code: string; name: string }> = {
    cyrillic: { code: 'ru', name: 'Russian (detected by script)' },
    arabic: { code: 'ar', name: 'Arabic' },
    hebrew: { code: 'he', name: 'Hebrew' },
    devanagari: { code: 'hi', name: 'Hindi' },
    cjk: { code: 'zh', name: 'Chinese/Japanese/Korean' },
    thai: { code: 'th', name: 'Thai' },
    greek: { code: 'el', name: 'Greek' },
    korean: { code: 'ko', name: 'Korean' },
    japanese: { code: 'ja', name: 'Japanese' },
  };

  const fallback = scriptLanguage[script];
  if (fallback) {
    return { ...fallback, confidence: 0.5, script };
  }

  // Default to English for latin script
  return { code: 'en', name: 'English (assumed)', confidence: 0.3, script: 'latin' };
}

// ──────────────────────────────────────────────────────────────
//  NAMED-ENTITY RECOGNITION
//  Pattern-based extraction of entities from text.
// ──────────────────────────────────────────────────────────────

export interface NamedEntity {
  text: string;
  type: 'person' | 'organization' | 'location' | 'date' | 'email' | 'phone' | 'url' | 'money' | 'percentage' | 'hashtag' | 'mention' | 'ip_address';
  start: number;
  end: number;
  confidence: number;
}

// Common person name prefixes (titles)
const NAME_TITLES = ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sir', 'Lady', 'Lord', 'Capt', 'Sgt', 'Lt', 'Gen', 'Adm', 'Hon', 'Rev', 'Fr'];

/**
 * Extract named entities from text using regex patterns.
 * No external dependencies required.
 */
export function extractNamedEntities(text: string): NamedEntity[] {
  const entities: NamedEntity[] = [];
  const seen = new Set<string>();

  function add(entity: Omit<NamedEntity, 'start' | 'end'> & { start: number; end: number }) {
    const key = `${entity.type}:${entity.text.toLowerCase()}:${entity.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push(entity);
  }

  // URLs
  const urlRe = /https?:\/\/[^\s<>"']+|www\.[a-zA-Z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    add({ text: m[0], type: 'url', start: m.index, end: m.index + m[0].length, confidence: 0.99 });
  }

  // Emails
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  while ((m = emailRe.exec(text)) !== null) {
    add({ text: m[0], type: 'email', start: m.index, end: m.index + m[0].length, confidence: 0.98 });
  }

  // Phone numbers (international, US, EU patterns)
  const phoneRe = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,9}(?:\s*(?:ext|x|ext.)\s*\d{1,5})?/g;
  while ((m = phoneRe.exec(text)) !== null) {
    const digits = m[0].replace(/[^0-9]/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      add({ text: m[0].trim(), type: 'phone', start: m.index, end: m.index + m[0].length, confidence: 0.9 });
    }
  }

  // IP addresses (IPv4)
  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  while ((m = ipRe.exec(text)) !== null) {
    const parts = m[0].split('.').map(Number);
    if (parts.every(p => p >= 0 && p <= 255)) {
      add({ text: m[0], type: 'ip_address', start: m.index, end: m.index + m[0].length, confidence: 0.95 });
    }
  }

  // Hashtags
  const hashtagRe = /#[a-zA-Z0-9_]+/g;
  while ((m = hashtagRe.exec(text)) !== null) {
    add({ text: m[0], type: 'hashtag', start: m.index, end: m.index + m[0].length, confidence: 0.95 });
  }

  // @mentions
  const mentionRe = /@[a-zA-Z0-9_.]+/g;
  while ((m = mentionRe.exec(text)) !== null) {
    add({ text: m[0], type: 'mention', start: m.index, end: m.index + m[0].length, confidence: 0.95 });
  }

  // Dates (various formats)
  const dateRe = /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})\b/gi;
  while ((m = dateRe.exec(text)) !== null) {
    add({ text: m[0], type: 'date', start: m.index, end: m.index + m[0].length, confidence: 0.9 });
  }

  // Money amounts
  const moneyRe = /(?:[$€£¥₽₩₪₱₿]\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:USD|EUR|GBP|JPY|RUB|CNY|INR|BRL|MXN|CAD|AUD|CHF|SEK|NOK|DKK|PLN|TRY|ZAR|HKD|SGD|TWD|KRW|THB|MYR|IDR|VND|PHP|ILS|AED|SAR))(?:\s*(?:million|billion|trillion|M|B|Billion|Million|K|k))?/gi;
  while ((m = moneyRe.exec(text)) !== null) {
    add({ text: m[0], type: 'money', start: m.index, end: m.index + m[0].length, confidence: 0.85 });
  }

  // Percentages
  const pctRe = /\b\d+(?:[.,]\d+)?\s*%/g;
  while ((m = pctRe.exec(text)) !== null) {
    add({ text: m[0], type: 'percentage', start: m.index, end: m.index + m[0].length, confidence: 0.95 });
  }

  // Organizations: capitalized multi-word patterns (not at start of sentence)
  // "Apple", "Microsoft", "Google", "UK government", "North Korea"
  const orgRe = /(?:[A-Z][a-z]+(?:\s+(?:of|and|&|de|da|von|der)\s+)?)+[A-Z][a-z]+|(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g;
  while ((m = orgRe.exec(text) as RegExpExecArray | null) !== null) {
    const word = m[0];
    // Skip if it's just a capitalized word that looks like a person name
    if (word.split(/\s+/).length < 2) continue;
    // Skip if at start of a sentence (likely a person's name)
    const beforeChar = text[m.index - 1] || '.';
    if (beforeChar === '.' || beforeChar === '!' || beforeChar === '?') continue;
    // Skip common person patterns like "John Smith"
    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(word)) {
      // Could be person OR org — mark as low confidence org
      add({ text: word, type: 'organization', start: m.index, end: m.index + word.length, confidence: 0.5 });
    } else {
      add({ text: word, type: 'organization', start: m.index, end: m.index + word.length, confidence: 0.6 });
    }
  }

  // Locations: known location keywords + capitalized patterns
  const locationKeywords = /\b(?:in|at|from|to|near|via|across|throughout|around)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  while ((m = locationKeywords.exec(text)) !== null) {
    const loc = m[1];
    if (loc.split(/\s+/).length <= 3) {
      add({ text: loc, type: 'location', start: m.index + (text.slice(m.index).indexOf(loc)), end: m.index + (text.slice(m.index).indexOf(loc)) + loc.length, confidence: 0.55 });
    }
  }

  // People: Title + Capitalized Name patterns
  const titleRe = new RegExp(`\\b(?:${NAME_TITLES.join('|')})\\.?\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?`, 'g');
  while ((m = titleRe.exec(text)) !== null) {
    add({ text: m[0], type: 'person', start: m.index, end: m.index + m[0].length, confidence: 0.85 });
  }

  // People: "Capitalized Capitalized" in specific contexts (not start of sentence)
  // e.g. "by John Smith", "with Jane Doe", "said John Smith", "according to John Smith"
  const personContextRe = /\b(?:by|with|said|called|named|known.as|according.to|interviewed|appointed|contacted|led.by|founded.by|attributed.to|blamed|praised|criticized|fired|hired|promoted)\s+([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/gi;
  while ((m = personContextRe.exec(text)) !== null) {
    const full = `${m[1]} ${m[2]}`;
    add({ text: full, type: 'person', start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + full.length, confidence: 0.8 });
  }

  return entities;
}

// ──────────────────────────────────────────────────────────────
//  KEYWORD / TOPIC EXTRACTION
//  Frequency-weighted term extraction with stopword filtering.
// ──────────────────────────────────────────────────────────────

export interface TopicResult {
  term: string;        // The keyword / topic
  score: number;       // 0–1 relevance score
  frequency: number;   // Raw count in the text
  type: 'unigram' | 'bigram' | 'trigram' | 'entity_type';
}

// General-purpose stopwords that carry little topical meaning
const TOPIC_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'as', 'is', 'was', 'were', 'are', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'this', 'that', 'these', 'those', 'it', 'its',
  'they', 'them', 'their', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'hers', 'not', 'no', 'nor', 'so', 'very', 'too', 'just', 'also',
  'then', 'than', 'now', 'more', 'most', 'some', 'any', 'each', 'every', 'all',
  'both', 'few', 'much', 'many', 'such', 'only', 'own', 'same', 'other', 'into',
  'over', 'after', 'before', 'between', 'through', 'during', 'about', 'above',
  'below', 'up', 'down', 'out', 'off', 'under', 'again', 'further', 'once',
  'here', 'there', 'when', 'where', 'why', 'how', 'which', 'who', 'whom',
  'because', 'while', 'until', 'unless', 'since', 'although', 'though', 'if',
  'like', 'well', 'get', 'got', 'go', 'goes', 'went', 'come', 'came', 'take',
  'took', 'make', 'made', 'say', 'said', 'see', 'saw', 'know', 'knew', 'think',
  'thought', 'give', 'gave', 'find', 'found', 'tell', 'told', 'become', 'became',
  'leave', 'left', 'feel', 'felt', 'put', 'set', 'let', 'keep', 'hold', 'begin',
  'began', 'start', 'started', 'show', 'shown', 'hear', 'heard', 'play', 'played',
  'run', 'ran', 'move', 'moved', 'live', 'lived', 'believe', 'bring', 'brought',
  'happen', 'happened', 'write', 'wrote', 'provide', 'provide', 'seem', 'help',
  'turn', 'turn', 'cause', 'result', 'change', 'lead', 'led', 'include', 'change',
  'regarding', 'including', 'following', 'according', 'based', 'within', 'without',
  'across', 'around', 'behind', 'along', 'among', 'via', 'versus', 'plus',
]);

/**
 * Extract keywords from text using frequency-based scoring with stopword filtering.
 * Returns unigrams, bigrams, and trigrams weighted by frequency and length.
 */
export function extractKeywords(text: string, maxTerms: number = 20): TopicResult[] {
  if (!text || text.trim().length < 5) return [];

  // Tokenize
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 1 && !TOPIC_STOPWORDS.has(t) && !/^\d+$/.test(t));

  if (tokens.length < 3) return [];

  // Unigram frequency
  const unigramFreq = new Map<string, number>();
  for (const t of tokens) {
    unigramFreq.set(t, (unigramFreq.get(t) || 0) + 1);
  }

  // Bigram frequency
  const bigramFreq = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    bigramFreq.set(bigram, (bigramFreq.get(bigram) || 0) + 1);
  }

  // Trigram frequency
  const trigramFreq = new Map<string, number>();
  for (let i = 0; i < tokens.length - 2; i++) {
    const trigram = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    trigramFreq.set(trigram, (trigramFreq.get(trigram) || 0) + 1);
  }

  const totalTokens = tokens.length;
  const results: TopicResult[] = [];

  // Score unigrams: TF * bonus for longer words (more specific)
  for (const [term, freq] of unigramFreq) {
    if (term.length < 3) continue;
    const tf = freq / totalTokens;
    const lengthBonus = Math.min(1, term.length / 10);
    const score = Math.min(1, tf * 5 * lengthBonus);
    if (score > 0.01) {
      results.push({ term, score, frequency: freq, type: 'unigram' });
    }
  }

  // Score bigrams: higher weight for phrases
  for (const [term, freq] of bigramFreq) {
    if (freq < 1) continue;
    const tf = freq / totalTokens;
    // Bigram bonus: phrases are more specific
    const score = Math.min(1, tf * 10);
    if (score > 0.02) {
      results.push({ term, score, frequency: freq, type: 'bigram' });
    }
  }

  // Score trigrams
  for (const [term, freq] of trigramFreq) {
    if (freq < 1) continue;
    const tf = freq / totalTokens;
    const score = Math.min(1, tf * 15);
    if (score > 0.03) {
      results.push({ term, score, frequency: freq, type: 'trigram' });
    }
  }

  // Sort by score descending, return top N
  return results.sort((a, b) => b.score - a.score).slice(0, maxTerms);
}

// ──────────────────────────────────────────────────────────────
//  TOXICITY / ABUSE SCORING
//  Weighted pattern-based scoring for content moderation.
// ──────────────────────────────────────────────────────────────

export interface ToxicityResult {
  score: number;         // 0–1 overall toxicity score
  categories: Record<string, number>;  // Per-category scores
  flagged: boolean;      // True if any category exceeds threshold
  threshold: number;     // Configurable threshold (default 0.7)
}

// Pattern templates for different toxicity categories
// Using word-boundary matching to avoid false positives on substrings
interface ToxicityPattern {
  category: string;
  label: string;
  patterns: RegExp[];
  weight: number;  // How much this category contributes to the overall score
}

const TOXICITY_PATTERNS: ToxicityPattern[] = [
  {
    category: 'hate_speech',
    label: 'Hate Speech',
    weight: 1.0,
    patterns: [
      // These patterns are intentionally broad for safety screening
      /\b(hate|hates|hatred)\s+(speech|crime|group|mongering)\b/i,
      /\b(hateful|racist|bigot(?:ry|ed?))\b/i,
      /\b(supremac(?:ist|y)|white.nationalist|neo.nazi)\b/i,
      /\b(ethnic.cleansing|genocide|racial.slur)\b/i,
      /\b(antisemitic|islamophobic|homophobic|transphobic|xenophobic)\b/i,
    ],
  },
  {
    category: 'harassment',
    label: 'Harassment',
    weight: 0.9,
    patterns: [
      /\b(kill\s+(?:yourself|your|them)|die|murder)\s+(?:you|them)\b/i,
      /\b(harass(?:ment)?|bully(?:ing)?|doxx?ing|stalking)\b/i,
      /\b(threaten(?:ing)?|extort(?:ion)?|blackmail)\b/i,
      /\b(rape|sexual.assault|abuse)\b/i,
      /\b(intimidat(?:e|ion|ory)|coerci(?:on|ve))\b/i,
    ],
  },
  {
    category: 'profanity',
    label: 'Profanity',
    weight: 0.6,
    patterns: [
      /\b(f[u*]ck(?:ing|er|ed)?|sh[i*]t|b[i*]tch|ass\b|d[i*]ck)\b/i,
      /\b(motherfucker|bullshit|horseshit|crap)\b/i,
      /\b(damn|damnit|goddamn|hell)\b/i,
    ],
  },
  {
    category: 'violence',
    label: 'Violence',
    weight: 0.9,
    patterns: [
      /\b(kill(?:ing|er|ed)?|murder(?:er|ed|ing)?|assassinat(?:e|ion|ed|ing)?)\b/i,
      /\b(behead(?:ing)?|execut(?:e|ion|ed|ing)|torture|tortured)\b/i,
      /\b(bomb(?:ing)?|explosi(?:on|ve)|shoot(?:ing|er|s?)|stab(?:bing|bed)?)\b/i,
      /\b(terrorist?\b|terrorism|extremist|radicaliz(?:e|ation|ed))\b/i,
      /\b(hostage|kidnap(?:ping|ped)?|abduct(?:ion|ed)?)\b/i,
    ],
  },
  {
    category: 'self_harm',
    label: 'Self Harm',
    weight: 1.0,
    patterns: [
      /\b(suicide|kill\s+(?:myself|oneself))\b/i,
      /\b(self.harm|self.hate|cutt?ing)\b/i,
      /\b(depress(?:ed|ion|ing)|hopeless|worthless)\b/i,
    ],
  },
  {
    category: 'spam',
    label: 'Spam',
    weight: 0.4,
    patterns: [
      /\b(buy\s+now|click\s+here|limited\s+time|act\s+now)\b/i,
      /\b(congratulation|you.ve.won|free\s+(?:money|prize|gift))\b/i,
      /\b(earn\s+money|work\s+from\s+home|make\s+money\s+fast)\b/i,
      /\b(follow\s+me|subscribe|like\s+and\s+share|check\s+out\s+my)\b/i,
    ],
  },
  {
    category: 'misinformation',
    label: 'Misinformation',
    weight: 0.7,
    patterns: [
      /\b(fake\s+news|alternative\s+fact|disinformation)\b/i,
      /\b(conspiracy\s+theor(?:y|ist)|deep\s+state|cabal)\b/i,
      /\b(hoax|cover.up|false.flag|psyop)\b/i,
      /\b(plandemic|chemtrail|flat.earth|antivaxx?)\b/i,
    ],
  },
];

/**
 * Score text for toxicity across multiple categories.
 * Returns per-category scores and an overall score.
 */
export function scoreToxicity(text: string, threshold: number = 0.7): ToxicityResult {
  if (!text || text.trim().length < 5) {
    return { score: 0, categories: {}, flagged: false, threshold };
  }

  const categories: Record<string, number> = {};
  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const cat of TOXICITY_PATTERNS) {
    let matches = 0;
    for (const pattern of cat.patterns) {
      const matchCount = (text.match(pattern) || []).length;
      matches += matchCount;
    }

    // Calculate category score: 0–1 based on match density
    const textLen = text.length;
    const maxExpected = Math.ceil(textLen / 50); // Expect ~1 match per 50 chars
    const catScore = Math.min(1, matches / Math.max(1, maxExpected));
    categories[cat.category] = catScore;

    totalWeightedScore += catScore * cat.weight;
    totalWeight += cat.weight;
  }

  const overall = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

  return {
    score: Math.round(overall * 1000) / 1000,
    categories,
    flagged: overall >= threshold || Object.values(categories).some(s => s >= 0.9),
    threshold,
  };
}

// ──────────────────────────────────────────────────────────────
//  TEXT STATISTICS
// ──────────────────────────────────────────────────────────────

export interface TextStats {
  charCount: number;
  wordCount: number;
  sentenceCount: number;
  avgWordLength: number;
  readingTimeSeconds: number;
  uniqueWords: number;
  lexicalDiversity: number;
  containsUrl: boolean;
  containsEmail: boolean;
  containsPhone: boolean;
}

export function computeTextStats(text: string): TextStats {
  if (!text) return {
    charCount: 0, wordCount: 0, sentenceCount: 0,
    avgWordLength: 0, readingTimeSeconds: 0, uniqueWords: 0,
    lexicalDiversity: 0, containsUrl: false, containsEmail: false, containsPhone: false,
  };

  const words = text.split(/\s+/).filter(w => w.length > 0);
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const uniqueWords = new Set(words.map(w => w.toLowerCase()));

  return {
    charCount: text.length,
    wordCount: words.length,
    sentenceCount: sentences.length,
    avgWordLength: words.length > 0 ? words.reduce((s, w) => s + w.length, 0) / words.length : 0,
    readingTimeSeconds: Math.ceil(words.length / 3.33), // ~200 words per minute
    uniqueWords: uniqueWords.size,
    lexicalDiversity: words.length > 0 ? uniqueWords.size / words.length : 0,
    containsUrl: /https?:\/\/|www\./i.test(text),
    containsEmail: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text),
    containsPhone: /\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,9}/.test(text),
  };
}

// ──────────────────────────────────────────────────────────────
//  COMBINED ENRICHMENT PIPELINE
// ──────────────────────────────────────────────────────────────

export interface EnrichmentResult {
  language: LanguageResult;
  entities: NamedEntity[];
  keywords: TopicResult[];
  toxicity: ToxicityResult;
  stats: TextStats;
  /** Tags derived from enrichment (for attaching to entities) */
  tags: string[];
  /** Enriched properties (for updating entity properties) */
  enrichedProperties: Record<string, any>;
}

/**
 * Run the full NLP enrichment pipeline on a text string.
 * Returns language, entities, keywords, toxicity, stats, tags, and properties.
 */
export function enrichText(text: string): EnrichmentResult {
  const language = detectLanguage(text);
  const entities = extractNamedEntities(text);
  const keywords = extractKeywords(text);
  const toxicity = scoreToxicity(text);
  const stats = computeTextStats(text);

  // Build structured tags from enrichment
  const tags: string[] = [
    `lang:${language.code}`,
  ];

  // Add language-specific tag
  if (language.confidence > 0.5) {
    tags.push(`detected_${language.code}`);
  }

  // Add entity type presence tags
  const entityTypes = new Set(entities.map(e => e.type));
  if (entityTypes.has('person')) tags.push('mentions_people');
  if (entityTypes.has('organization')) tags.push('mentions_orgs');
  if (entityTypes.has('location')) tags.push('mentions_locations');
  if (entityTypes.has('email')) tags.push('contains_email');
  if (entityTypes.has('phone')) tags.push('contains_phone');
  if (entityTypes.has('url')) tags.push('contains_url');
  if (entityTypes.has('hashtag')) tags.push('contains_hashtags');
  if (entityTypes.has('mention')) tags.push('contains_mentions');
  if (entityTypes.has('date')) tags.push('contains_dates');
  if (entityTypes.has('money')) tags.push('contains_money');

  // Add toxicity flags
  if (toxicity.flagged) {
    tags.push('flagged_content');
    if (toxicity.score > 0.8) tags.push('high_toxicity');
    for (const [cat, score] of Object.entries(toxicity.categories)) {
      if (score > 0.7) tags.push(`toxicity:${cat}`);
    }
  } else {
    tags.push('clean_content');
  }

  // Add readability stats
  if (stats.lexicalDiversity > 0.7) tags.push('highly_varied');
  if (stats.wordCount > 200) tags.push('long_form');
  if (stats.wordCount < 20) tags.push('short_form');

  // Add top keywords as tags (top 5)
  for (const kw of keywords.slice(0, 5)) {
    if (kw.term.length > 2) {
      tags.push(`topic:${kw.term.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`);
    }
  }

  // Build enriched properties
  const enrichedProperties: Record<string, any> = {
    nlp_language: language.code,
    nlp_language_confidence: language.confidence,
    nlp_toxicity_score: toxicity.score,
    nlp_toxicity_flagged: toxicity.flagged,
    nlp_entity_count: entities.length,
    nlp_keyword_count: keywords.length,
    nlp_word_count: stats.wordCount,
    nlp_reading_time: stats.readingTimeSeconds,
    nlp_lexical_diversity: Math.round(stats.lexicalDiversity * 100) / 100,
  };

  // Add detected entities summary
  if (entities.length > 0) {
    enrichedProperties.nlp_detected_people = entities.filter(e => e.type === 'person').map(e => e.text).slice(0, 20);
    enrichedProperties.nlp_detected_orgs = entities.filter(e => e.type === 'organization').map(e => e.text).slice(0, 20);
    enrichedProperties.nlp_detected_locations = entities.filter(e => e.type === 'location').map(e => e.text).slice(0, 20);
    enrichedProperties.nlp_detected_emails = entities.filter(e => e.type === 'email').map(e => e.text).slice(0, 10);
    enrichedProperties.nlp_detected_phones = entities.filter(e => e.type === 'phone').map(e => e.text).slice(0, 10);
    enrichedProperties.nlp_detected_urls = entities.filter(e => e.type === 'url').map(e => e.text).slice(0, 10);
  }

  // Add top keywords
  if (keywords.length > 0) {
    enrichedProperties.nlp_top_keywords = keywords.slice(0, 10).map(k => k.term);
    enrichedProperties.nlp_topics = keywords.filter(k => k.type !== 'unigram').slice(0, 5).map(k => k.term);
  }

  // Add toxicity per-category breakdown
  if (toxicity.flagged) {
    enrichedProperties.nlp_toxicity_categories = toxicity.categories;
  }

  return {
    language,
    entities,
    keywords,
    toxicity,
    stats,
    tags,
    enrichedProperties,
  };
}

/**
 * Apply NLP enrichment to entity properties.
 * Updates the entity's properties with NLP analysis data and adds tags.
 * Returns the entity with enriched properties merged in.
 */
export function enrichEntityProperties(
  existingProperties: Record<string, any>,
  enrichment: EnrichmentResult,
): { properties: Record<string, any>; newTags: string[] } {
  const properties = { ...existingProperties };

  // Only overwrite if not already set (preserve existing values)
  if (!properties.nlp_language) properties.nlp_language = enrichment.language.code;
  if (!properties.nlp_toxicity_score) properties.nlp_toxicity_score = enrichment.toxicity.score;
  if (!properties.nlp_entity_count) properties.nlp_entity_count = enrichment.entities.length;
  if (!properties.nlp_word_count) properties.nlp_word_count = enrichment.stats.wordCount;
  if (!properties.nlp_keyword_count) properties.nlp_keyword_count = enrichment.keywords.length;

  properties.nlp_enriched = true;
  properties.nlp_enriched_at = new Date().toISOString();

  return {
    properties,
    newTags: enrichment.tags,
  };
}
