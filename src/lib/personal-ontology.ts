/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Personal Ontology Types
 *  Entity model for personal data cross-referencing
 * ═══════════════════════════════════════════════════════════════
 */

// ── Domain ──
export enum PersonalDomain {
  PERSON = 'PERSON',
  COMMUNICATION = 'COMMUNICATION',
  SOCIAL = 'SOCIAL',
  IDENTITY = 'IDENTITY',
  VEHICLE = 'VEHICLE',
  LOCATION = 'LOCATION',
  NETWORK = 'NETWORK',
  EVENT = 'EVENT',
  MEDIA = 'MEDIA',
}

// ── Entity Types ──
export type PersonalEntityType =
  | 'person'
  | 'phone_number'
  | 'social_profile'
  | 'personal_id'
  | 'vehicle'
  | 'place'
  | 'mac_address'
  | 'wifi_network'
  | 'event'
  | 'image_media'
  // ── Data Fusion additions (see lib/store/document-store.ts) ──
  // Entity kinds NER extraction resolves out of ingested unstructured
  // text, plus `media` for the ingested document node itself.
  | 'organization'
  | 'email_address'
  | 'network_node'
  | 'media';

// ── Core Personal Entity ──
export interface PersonalEntity {
  id: string;
  type: PersonalEntityType;
  domain: PersonalDomain;
  label: string;
  description?: string;
  coordinates?: { lat: number; lng: number };
  timestamp?: string;
  properties: Record<string, any>;
  tags: string[];
  linkedEntityIds?: string[];  // IDs of related entities
  source: string;              // how it was ingested
  createdAt: string;
  updatedAt: string;
  graphPos?: { x: number; y: number };  // persisted layout position for the Link Editor (optional, ignored elsewhere)
}

// ── Relationship Types ──
export interface PersonalRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;           // e.g. "owns", "registered_to", "called", "posted", "located_at"
  strength: number;        // 0-1 confidence
  metadata?: Record<string, any>;
  createdAt: string;
}

// ── Graph Data ──
export interface PersonalGraphNode {
  id: string;
  label: string;
  type: PersonalEntityType;
  domain: PersonalDomain;
  properties?: Record<string, any>;
  coordinates?: { lat: number; lng: number };
  x?: number;
  y?: number;
}

export interface PersonalGraphLink {
  source: string;
  target: string;
  label: string;
  strength: number;
}

export interface PersonalGraphData {
  nodes: PersonalGraphNode[];
  links: PersonalGraphLink[];
}

// ── Colors & Display ──
export const PERSONAL_TYPE_COLORS: Record<PersonalEntityType, string> = {
  person: '#B388FF',
  phone_number: '#00E5FF',
  social_profile: '#FF6D00',
  personal_id: '#D4AF37',
  vehicle: '#FF3D3D',
  place: '#76FF03',
  mac_address: '#39FF14',
  wifi_network: '#00BCD4',
  event: '#FF9500',
  image_media: '#E040FB',
  organization: '#C9A227',
  email_address: '#4F6FFF',
  network_node: '#00C2A8',
  media: '#9B9B9B',
};

export const PERSONAL_DOMAIN_COLORS: Record<PersonalDomain, string> = {
  PERSON: '#B388FF',
  COMMUNICATION: '#00E5FF',
  SOCIAL: '#FF6D00',
  IDENTITY: '#D4AF37',
  VEHICLE: '#FF3D3D',
  LOCATION: '#76FF03',
  NETWORK: '#39FF14',
  EVENT: '#FF9500',
  MEDIA: '#E040FB',
};

export const PERSONAL_TYPE_LABELS: Record<PersonalEntityType, string> = {
  person: 'Person',
  phone_number: 'Phone Number',
  social_profile: 'Social Media',
  personal_id: 'ID Document',
  vehicle: 'Vehicle',
  place: 'Place',
  mac_address: 'MAC Address',
  wifi_network: 'WiFi Network',
  event: 'Event',
  image_media: 'Image/Media',
  organization: 'Organization',
  email_address: 'Email Address',
  network_node: 'Network Node',
  media: 'Document',
};

// ── LocalStorage Store ──
const STORE_KEY = 'osiris_personal_graph';

export interface PersonalStore {
  entities: PersonalEntity[];
  relationships: PersonalRelationship[];
  version: number;
  // Persisted "not the same person" decisions from the cross-platform identity
  // resolution review queue (see lib/identity-resolution.ts). Optional + ignored
  // by everything else, so older saves remain fully compatible.
  identityDecisions?: { pairKey: string; decision: 'rejected'; at: string }[];
}

/**
 * Per-user workspace isolation: when a user id is supplied the store is
 * namespaced to that account, so each analyst's personal graph is kept
 * separate on the same browser. Logged-out / anonymous sessions fall back
 * to the shared base key (backward compatible with older saves).
 */
function storeKey(userId?: string): string {
  return userId ? `${STORE_KEY}:${userId}` : STORE_KEY;
}

export function loadPersonalStore(userId?: string): PersonalStore {
  try {
    const raw = localStorage.getItem(storeKey(userId));
    if (raw) return JSON.parse(raw);
  } catch {}
  return { entities: [], relationships: [], version: 1 };
}

export function savePersonalStore(store: PersonalStore, userId?: string) {
  try {
    localStorage.setItem(storeKey(userId), JSON.stringify({ ...store, version: (store.version || 0) + 1 }));
  } catch {}
}

// ── Graph Builder ──
export function buildGraph(store: PersonalStore): PersonalGraphData {
  const nodes: PersonalGraphNode[] = store.entities.map(e => ({
    id: e.id,
    label: e.label,
    type: e.type,
    domain: e.domain,
    properties: e.properties,
    coordinates: e.coordinates,
  }));

  const links: PersonalGraphLink[] = store.relationships.map(r => ({
    source: r.sourceId,
    target: r.targetId,
    label: r.label,
    strength: r.strength,
  }));

  return { nodes, links };
}

// ── Cross-Referencing Engine ──
const CROSS_REF_RULES: {
  sourceType: PersonalEntityType;
  targetType: PersonalEntityType;
  label: string;
  match: (src: PersonalEntity, tgt: PersonalEntity) => number; // 0 = no match, >0 = confidence
}[] = [
  // Phone → Person: same name in contact
  {
    sourceType: 'phone_number', targetType: 'person',
    label: 'contact_of',
    match: (src, tgt) => {
      const srcName = (src.properties.contactName || '').toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (srcName && tgtName && srcName.includes(tgtName)) return 0.9;
      return 0;
    },
  },
  // Phone → Social: same number in bio/contact
  {
    sourceType: 'phone_number', targetType: 'social_profile',
    label: 'linked_to',
    match: (src, tgt) => {
      const num = src.properties.number || src.label;
      const bio = (tgt.properties.bio || tgt.properties.description || '').toLowerCase();
      if (num && bio.includes(num.replace(/[^0-9]/g, ''))) return 0.85;
      return 0;
    },
  },
  // Social → Person: same name
  {
    sourceType: 'social_profile', targetType: 'person',
    label: 'profile_of',
    match: (src, tgt) => {
      const srcName = (src.properties.displayName || src.label).toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (srcName && tgtName && (srcName.includes(tgtName) || tgtName.includes(srcName))) return 0.8;
      // Check email overlap
      const email = (src.properties.email || '').toLowerCase();
      const personEmail = (tgt.properties.email || '').toLowerCase();
      if (email && personEmail && email === personEmail) return 1.0;
      return 0;
    },
  },
  // Vehicle → Person: owner field
  {
    sourceType: 'vehicle', targetType: 'person',
    label: 'owned_by',
    match: (src, tgt) => {
      const owner = (src.properties.owner || '').toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (owner && tgtName && owner.includes(tgtName)) return 0.9;
      return 0;
    },
  },
  // MAC → WiFi: seen on this network
  {
    sourceType: 'mac_address', targetType: 'wifi_network',
    label: 'connected_to',
    match: (src, tgt) => {
      const srcNetworks: string[] = src.properties.wifiNetworks || [];
      if (srcNetworks.includes(tgt.properties.ssid || tgt.label)) return 0.95;
      return 0;
    },
  },
  // MAC → Person: device owner
  {
    sourceType: 'mac_address', targetType: 'person',
    label: 'device_of',
    match: (src, tgt) => {
      const owner = (src.properties.owner || '').toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (owner && tgtName && owner.includes(tgtName)) return 0.85;
      return 0;
    },
  },
  // Place → Person: residence
  {
    sourceType: 'place', targetType: 'person',
    label: 'residence_of',
    match: (src, tgt) => {
      const residents: string[] = src.properties.residents || [];
      const tgtName = (tgt.label || '').toLowerCase();
      if (residents.some(r => r.toLowerCase().includes(tgtName))) return 0.9;
      return 0;
    },
  },
  // ID → Person
  {
    sourceType: 'personal_id', targetType: 'person',
    label: 'identifies',
    match: (src, tgt) => {
      const nameOnID = (src.properties.fullName || '').toLowerCase();
      const tgtName = (tgt.label || '').toLowerCase();
      if (nameOnID && tgtName && nameOnID.includes(tgtName)) return 0.95;
      return 0;
    },
  },
  // Event → Place: occurred at
  {
    sourceType: 'event', targetType: 'place',
    label: 'occurred_at',
    match: (src, tgt) => {
      if (!src.coordinates || !tgt.coordinates) return 0;
      const d = haversineKm(src.coordinates.lat, src.coordinates.lng, tgt.coordinates.lat, tgt.coordinates.lng);
      return d < 1 ? 0.95 : d < 10 ? 0.7 : d < 50 ? 0.4 : 0;
    },
  },
  // Event → Person: involved
  {
    sourceType: 'event', targetType: 'person',
    label: 'involved',
    match: (src, tgt) => {
      const participants: string[] = src.properties.participants || [];
      const tgtName = (tgt.label || '').toLowerCase();
      if (participants.some(p => p.toLowerCase().includes(tgtName))) return 0.9;
      return 0;
    },
  },
];

function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
  return dp[m][n];
}

function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  // Check if one contains the other
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  // Check fuzzy match via Levenshtein
  const dist = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  const sim = 1 - dist / maxLen;
  if (sim >= 0.85) return 0.85; // Very close match (e.g. "Jon Smith" vs "John Smith")
  if (sim >= 0.7) return 0.7;  // Close match
  return 0;
}

/**
 * Cross-platform identity resolution: links 'same_as' edges between
 * entities that fuzzy-name-match OR share a phone/email identifier,
 * so one human resolves to one ontology entity cluster.
 */
const IDENTITY_RESOLUTION_RULES: {
  label: string;
  match: (a: PersonalEntity, b: PersonalEntity) => number;
}[] = [
  // ── Same phone number across any entity types ──
  {
    label: 'same_as',
    match: (a, b) => {
      const aPhone = (a.properties.phone || a.properties.number || '').replace(/[^0-9+]/g, '');
      const bPhone = (b.properties.phone || b.properties.number || '').replace(/[^0-9+]/g, '');
      if (aPhone && bPhone && aPhone === bPhone && aPhone.length >= 8) return 1.0;
      if (aPhone && bPhone && aPhone.slice(-8) === bPhone.slice(-8)) return 0.9;
      return 0;
    }
  },
  // ── Same email across any entity types ──
  {
    label: 'same_as',
    match: (a, b) => {
      const aEmail = (a.properties.email || '').toLowerCase().trim();
      const bEmail = (b.properties.email || '').toLowerCase().trim();
      if (aEmail && bEmail && aEmail === bEmail) return 1.0;
      return 0;
    }
  },
  // ── Person-to-Person: fuzzy name match across platforms ──
  {
    label: 'same_as',
    match: (a, b) => {
      if (a.type !== 'person' || b.type !== 'person') return 0;
      if (a.id === b.id) return 0;
      const aName = a.label || '';
      const bName = b.label || '';
      // Try full name match
      const fullSim = nameSimilarity(aName, bName);
      if (fullSim >= 0.85) return fullSim;
      // Check alias overlap (e.g. "Elena M." == "Elena Morozova")
      const aAliases: string[] = a.properties.aliases || [];
      const bAliases: string[] = b.properties.aliases || [];
      for (const aliasA of [aName, ...aAliases]) {
        for (const aliasB of [bName, ...bAliases]) {
          if (nameSimilarity(aliasA, aliasB) >= 0.85) return 0.85;
        }
      }
      return 0;
    }
  },
  // ── Profile-to-Person: display name fuzzy match ──
  {
    label: 'same_as',
    match: (a, b) => {
      if (a.type === 'social_profile' && b.type === 'person') {
        const displayName = (a.properties.displayName || a.label || '').toLowerCase();
        const personName = (b.label || '').toLowerCase();
        return nameSimilarity(displayName, personName) >= 0.7 ? 0.85 : 0;
      }
      if (a.type === 'person' && b.type === 'social_profile') {
        const displayName = (b.properties.displayName || b.label || '').toLowerCase();
        const personName = (a.label || '').toLowerCase();
        return nameSimilarity(displayName, personName) >= 0.7 ? 0.85 : 0;
      }
      return 0;
    }
  },
  // ── ID Document to Person: fuzzy name on document ──
  {
    label: 'same_as',
    match: (a, b) => {
      const [idEntity, personEntity] = a.type === 'personal_id' ? [a, b] : b.type === 'personal_id' ? [b, a] : [null, null];
      if (!idEntity || personEntity.type !== 'person') return 0;
      const idName = (idEntity.properties.fullName || '').toLowerCase();
      const personName = (personEntity.label || '').toLowerCase();
      return nameSimilarity(idName, personName) >= 0.7 ? 0.85 : 0;
    }
  },
  // ── Photo similarity: shared photo URL or face-embedding hash ──
  // Full impl requires face-detection API; stub links any entities
  // sharing the same photo_url or photo_embedding property.
  {
    label: 'same_as',
    match: (a, b) => {
      const aPhoto = a.properties.photo_url || a.properties.photo || '';
      const bPhoto = b.properties.photo_url || b.properties.photo || '';
      if (aPhoto && bPhoto && aPhoto === bPhoto) return 0.95;
      const aEmbed = a.properties.photo_embedding || '';
      const bEmbed = b.properties.photo_embedding || '';
      if (aEmbed && bEmbed && aEmbed === bEmbed) return 0.98;
      return 0;
    }
  },
  // ── Behavioural fingerprint: shared timezone + language pattern ──
  // Full impl analyses posting times, language model; stub checks
  // explicit timezone/language properties set by connectors.
  {
    label: 'same_as',
    match: (a, b) => {
      const aTz = a.properties.timezone || '';
      const bTz = b.properties.timezone || '';
      const aLang = a.properties.language || '';
      const bLang = b.properties.language || '';
      let score = 0;
      if (aTz && bTz && aTz === bTz) score += 0.4;
      if (aLang && bLang && aLang === bLang) score += 0.3;
      // Location overlap: similar GPS coordinates
      if (a.coordinates && b.coordinates) {
        const d = haversineKm(a.coordinates.lat, a.coordinates.lng, b.coordinates.lat, b.coordinates.lng);
        if (d < 10) score += 0.3;
        else if (d < 50) score += 0.15;
      }
      return Math.min(score, 0.95);
    }
  },
];

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Run cross-reference rules between all entities in the store.
 * Returns newly discovered relationships.
 */
export function crossReferenceStore(store: PersonalStore): PersonalRelationship[] {
  const existing = new Set(store.relationships.map(r => `${r.sourceId}:${r.targetId}:${r.label}`));
  const newRels: PersonalRelationship[] = [];
  const entities = store.entities;

  for (let i = 0; i < entities.length; i++) {
    for (let j = 0; j < entities.length; j++) {
      if (i === j) continue;
      const src = entities[i];
      const tgt = entities[j];

      for (const rule of CROSS_REF_RULES) {
        if (rule.sourceType !== src.type || rule.targetType !== tgt.type) continue;
        const key = `${src.id}:${tgt.id}:${rule.label}`;
        if (existing.has(key)) continue;
        const confidence = rule.match(src, tgt);
        if (confidence > 0.5) {
          newRels.push({
            id: `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            sourceId: src.id,
            targetId: tgt.id,
            label: rule.label,
            strength: confidence,
            createdAt: new Date().toISOString(),
          });
        }
      }
      // ── Identity resolution pass: fuzzy/identifier matching across all types ──
      for (const rule of IDENTITY_RESOLUTION_RULES) {
        if (src.id === tgt.id) continue;
        const key = `${src.id}:${tgt.id}:${rule.label}`;
        if (existing.has(key)) continue;
        const confidence = rule.match(src, tgt);
        if (confidence > 0.5) {
          newRels.push({
            id: `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            sourceId: src.id,
            targetId: tgt.id,
            label: rule.label,
            strength: confidence,
            metadata: { autoDiscovered: true, rule: 'identity_resolution' },
            createdAt: new Date().toISOString(),
          });
          existing.add(key);
        }
      }
    }
  }

  return newRels;
}

// ── Entity ID Generator ──
export function generateEntityId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Type Glyphs (2-char badge labels for the interactive Link Editor) ──
// Ported from the OSINT-Mapping-Tool identifier registry concept so each
// person-data node carries a compact, recognisable badge on the canvas.
export const PERSONAL_TYPE_GLYPHS: Record<PersonalEntityType, string> = {
  person: 'PR',
  phone_number: '☎',
  social_profile: '@',
  personal_id: 'ID',
  vehicle: 'CR',
  place: 'PL',
  mac_address: 'MAC',
  wifi_network: 'WiFi',
  event: 'EV',
  image_media: 'IMG',
  organization: 'ORG',
  email_address: '✉',
  network_node: 'NET',
  media: 'DOC',
};

// Common relationship labels offered when wiring two nodes together by hand.
export const RELATIONSHIP_LABELS: string[] = [
  'linked_to',
  'owns',
  'owned_by',
  'registered_to',
  'contact_of',
  'profile_of',
  'identifies',
  'located_at',
  'residence_of',
  'connected_to',
  'device_of',
  'involved',
  'family_of',
  'associate_of',
];

/**
 * Build a brand-new relationship record between two entities.
 * Used by the interactive Link Editor when an analyst draws an edge.
 */
export function makeRelationship(
  sourceId: string,
  targetId: string,
  label: string = 'linked_to',
  strength: number = 1,
): PersonalRelationship {
  return {
    id: `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sourceId,
    targetId,
    label,
    strength,
    createdAt: new Date().toISOString(),
  };
}
