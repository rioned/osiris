/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Cross-Platform Identity Resolution
 *
 *  Unify the same real person across every source into a single
 *  ontology node. The engine fuses signals from:
 *
 *    • an X / Twitter handle              (social_profile)
 *    • a Facebook / LinkedIn profile      (social_profile)
 *    • a WhatsApp number                  (phone_number)
 *    • a phone-contact entry              (phone_number)
 *    • a national ID                      (personal_id)
 *
 *  …onto a canonical `person` node, using:
 *
 *    1. fuzzy name / alias matching   (Jaro-Winkler, token-aware)
 *    2. shared phone / email          (exact identifier overlap)
 *    3. photo similarity              (URL match / perceptual hash)
 *    4. behavioural fingerprints      (shared associates + places)
 *
 *  Every proposed unification carries a 0..1 confidence score and
 *  flows through a MANUAL merge / split review queue — nothing is
 *  auto-merged. Merges are fully reversible: each fold records a
 *  provenance snapshot so an analyst can split a node back apart.
 *
 *  This module is intentionally PURE (no React, no I/O). It takes a
 *  PersonalStore and returns a new PersonalStore / candidate list,
 *  layering on top of the existing personal-ontology model without
 *  changing any of its behaviour.
 * ═══════════════════════════════════════════════════════════════
 */

import {
  PersonalEntity, PersonalRelationship, PersonalStore, PersonalEntityType,
} from './personal-ontology';

// ── Public types ───────────────────────────────────────────────

/** A single piece of evidence that two entities are the same person. */
export interface IdentitySignal {
  key: 'name' | 'phone' | 'email' | 'photo' | 'behavioural';
  label: string;
  score: number;   // 0..1 raw strength of this signal
  weight: number;  // 0..1 reliability of this signal class
  detail: string;  // human-readable explanation for the review queue
}

/** A proposed unification of two entities, awaiting human review. */
export interface IdentityCandidate {
  id: string;                    // stable key per unordered pair
  primaryId: string;             // canonical node the other folds into
  secondaryId: string;           // node to be folded in
  primaryLabel: string;
  secondaryLabel: string;
  primaryType: PersonalEntityType;
  secondaryType: PersonalEntityType;
  score: number;                 // 0..1 fused confidence
  signals: IdentitySignal[];     // breakdown of fired evidence
}

/** A persisted "these two are NOT the same" decision (suppresses a pair). */
export interface IdentityDecision {
  pairKey: string;
  decision: 'rejected';
  at: string;
}

/** One folded-in entity, snapshotted so a merge can be reversed (split). */
export interface MergeRecord {
  recordId: string;
  entity: PersonalEntity;                       // full snapshot of the folded node
  movedRelationships: { id: string; field: 'sourceId' | 'targetId'; from: string }[];
  removedRelationships: PersonalRelationship[]; // self-loops / duplicates dropped by the fold
  score: number;
  signals: IdentitySignal[];
  mergedAt: string;
}

// ── Tunables ───────────────────────────────────────────────────

// Reliability weights per signal class (how much to trust a full match).
const WEIGHTS = {
  name: 0.55,         // names alone are weak — many people share them
  phone: 0.9,         // a shared real phone number is strong
  email: 0.95,        // a shared email is the strongest soft identifier
  photo: 0.85,        // same avatar / face is strong
  behavioural: 0.6,   // shared associates + places is moderate
} as const;

// Only these types carry a real-world identity worth unifying.
const IDENTITY_TYPES: PersonalEntityType[] = [
  'person', 'social_profile', 'phone_number', 'personal_id',
];

// Lower priority number = more canonical (preferred as the surviving node).
const TYPE_PRIORITY: Record<string, number> = {
  person: 0, personal_id: 1, social_profile: 2, phone_number: 3,
};

// A pair must clear this fused confidence to enter the review queue.
const SURFACE_THRESHOLD = 0.5;

// ── String / identifier normalisation ──────────────────────────

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normName(s: string): string {
  return stripDiacritics(String(s || '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenised + alphabetically sorted name, so "John Smith" == "Smith, John". */
function canonName(s: string): string {
  return normName(s).split(' ').filter(Boolean).sort().join(' ');
}

function normPhone(s: string): string {
  const digits = String(s || '').replace(/\D/g, '');
  // Compare on the national significant number to absorb country-code noise.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ── Jaro-Winkler similarity (good for human names) ──────────────

function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;

  const matchDist = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3;

  // Winkler boost for a common prefix (up to 4 chars).
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ── Identifier extraction from an entity ────────────────────────

/** All name-like strings an entity exposes: label, aliases, handles, etc. */
function collectNames(e: PersonalEntity): string[] {
  const p = e.properties || {};
  const out: string[] = [e.label];
  for (const key of ['fullName', 'displayName', 'name', 'contactName', 'username', 'handle', 'screenName', 'legalName']) {
    if (p[key]) out.push(String(p[key]));
  }
  const aliasFields = [p.aliases, p.akas, p.otherNames];
  for (const list of aliasFields) {
    if (Array.isArray(list)) for (const a of list) if (a) out.push(String(a));
  }
  return uniq(out.map(s => s.trim()).filter(Boolean));
}

function collectPhones(e: PersonalEntity): string[] {
  const p = e.properties || {};
  const out: string[] = [];
  if (e.type === 'phone_number') out.push(e.label);
  for (const key of ['number', 'phone', 'phoneNumber', 'whatsapp', 'msisdn', 'mobile']) {
    if (p[key]) out.push(String(p[key]));
  }
  if (Array.isArray(p.phones)) for (const n of p.phones) if (n) out.push(String(n));
  return uniq(out.map(normPhone).filter(n => n.length >= 7));
}

function collectEmails(e: PersonalEntity): string[] {
  const p = e.properties || {};
  const out: string[] = [];
  for (const key of ['email', 'emailAddress', 'mail']) {
    if (p[key]) out.push(String(p[key]));
  }
  if (Array.isArray(p.emails)) for (const m of p.emails) if (m) out.push(String(m));
  return uniq(out.map(s => s.toLowerCase().trim()).filter(s => s.includes('@')));
}

function collectPhotoUrls(e: PersonalEntity): string[] {
  const p = e.properties || {};
  const out: string[] = [];
  for (const key of ['photoUrl', 'photo', 'avatar', 'avatarUrl', 'image', 'imageUrl', 'picture', 'profilePhoto']) {
    if (p[key]) out.push(String(p[key]));
  }
  return uniq(out.map(s => s.trim().toLowerCase()).filter(Boolean));
}

function collectPhotoHashes(e: PersonalEntity): string[] {
  const p = e.properties || {};
  const out: string[] = [];
  for (const key of ['photoHash', 'photo_hash', 'avatarHash', 'pHash', 'faceHash']) {
    if (p[key]) out.push(String(p[key]));
  }
  return uniq(out.map(s => s.replace(/[^0-9a-fx]/gi, '').toLowerCase()).filter(Boolean));
}

// ── Per-signal scorers ──────────────────────────────────────────

function nameScore(a: PersonalEntity, b: PersonalEntity): number {
  const namesA = collectNames(a);
  const namesB = collectNames(b);
  let best = 0;
  for (const na of namesA) {
    for (const nb of namesB) {
      const direct = jaroWinkler(normName(na), normName(nb));
      const tokenSorted = jaroWinkler(canonName(na), canonName(nb));
      best = Math.max(best, direct, tokenSorted);
    }
  }
  // Names below ~0.8 similarity are too noisy to count as evidence.
  return best >= 0.8 ? best : 0;
}

function phoneScore(a: PersonalEntity, b: PersonalEntity): number {
  const pa = collectPhones(a);
  const pb = collectPhones(b);
  if (!pa.length || !pb.length) return 0;
  return pa.some(x => pb.includes(x)) ? 1 : 0;
}

function emailScore(a: PersonalEntity, b: PersonalEntity): number {
  const ea = collectEmails(a);
  const eb = collectEmails(b);
  if (!ea.length || !eb.length) return 0;
  return ea.some(x => eb.includes(x)) ? 1 : 0;
}

/** Hamming-distance similarity over two equal-length hex perceptual hashes. */
function hashSimilarity(h1: string, h2: string): number {
  const a = h1.replace(/^0x/, '');
  const b = h2.replace(/^0x/, '');
  if (!a.length || a.length !== b.length) return a === b ? 1 : 0;
  let diffBits = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    if (Number.isNaN(x)) return 0;
    diffBits += (x.toString(2).match(/1/g) || []).length;
  }
  return clamp01(1 - diffBits / (a.length * 4));
}

function photoScore(a: PersonalEntity, b: PersonalEntity): number {
  const ua = collectPhotoUrls(a);
  const ub = collectPhotoUrls(b);
  if (ua.length && ub.length && ua.some(x => ub.includes(x))) return 1;

  const ha = collectPhotoHashes(a);
  const hb = collectPhotoHashes(b);
  let best = 0;
  for (const x of ha) for (const y of hb) best = Math.max(best, hashSimilarity(x, y));
  // Only a near-identical hash counts as evidence.
  return best >= 0.85 ? best : 0;
}

// ── Behavioural fingerprint (shared associates + places) ────────

/** Direct graph neighbours of an entity (ids it is linked to). */
function neighboursOf(id: string, rels: PersonalRelationship[]): Set<string> {
  const out = new Set<string>();
  for (const r of rels) {
    if (r.sourceId === id) out.add(r.targetId);
    else if (r.targetId === id) out.add(r.sourceId);
  }
  return out;
}

/** Coarse location cells (~1km) + named places an entity touches. */
function placesOf(e: PersonalEntity): Set<string> {
  const out = new Set<string>();
  if (e.coordinates) {
    out.add(`geo:${e.coordinates.lat.toFixed(2)},${e.coordinates.lng.toFixed(2)}`);
  }
  const p = e.properties || {};
  for (const key of ['city', 'location', 'place', 'address', 'homeCity']) {
    if (p[key]) out.add(`place:${normName(String(p[key]))}`);
  }
  if (Array.isArray(p.places)) for (const pl of p.places) if (pl) out.add(`place:${normName(String(pl))}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function behaviouralScore(a: PersonalEntity, b: PersonalEntity, rels: PersonalRelationship[]): number {
  // Shared associates: neighbours in common (excluding each other).
  const na = neighboursOf(a.id, rels); na.delete(b.id);
  const nb = neighboursOf(b.id, rels); nb.delete(a.id);
  const assoc = jaccard(na, nb);

  // Shared places: overlapping coarse locations.
  const place = jaccard(placesOf(a), placesOf(b));

  if (assoc === 0 && place === 0) return 0;
  // Combine the two behavioural views with a noisy-OR.
  return clamp01(1 - (1 - assoc * 0.9) * (1 - place * 0.7));
}

// ── Pairwise scoring + fusion ───────────────────────────────────

export function pairKeyOf(a: string, b: string): string {
  return [a, b].sort().join('::');
}

function buildSignals(a: PersonalEntity, b: PersonalEntity, rels: PersonalRelationship[]): IdentitySignal[] {
  const out: IdentitySignal[] = [];

  const name = nameScore(a, b);
  if (name > 0) out.push({
    key: 'name', label: 'Name / alias', score: name, weight: WEIGHTS.name,
    detail: `${Math.round(name * 100)}% fuzzy name match`,
  });

  const phone = phoneScore(a, b);
  if (phone > 0) out.push({
    key: 'phone', label: 'Shared phone', score: phone, weight: WEIGHTS.phone,
    detail: 'Same phone number on both',
  });

  const email = emailScore(a, b);
  if (email > 0) out.push({
    key: 'email', label: 'Shared email', score: email, weight: WEIGHTS.email,
    detail: 'Same email address on both',
  });

  const photo = photoScore(a, b);
  if (photo > 0) out.push({
    key: 'photo', label: 'Photo match', score: photo, weight: WEIGHTS.photo,
    detail: photo >= 1 ? 'Identical photo' : `${Math.round(photo * 100)}% photo similarity`,
  });

  const behav = behaviouralScore(a, b, rels);
  if (behav > 0) out.push({
    key: 'behavioural', label: 'Behaviour', score: behav, weight: WEIGHTS.behavioural,
    detail: `${Math.round(behav * 100)}% shared associates / places`,
  });

  return out;
}

/** Fuse independent signals with a noisy-OR so strong identifiers dominate. */
function fuse(signals: IdentitySignal[]): number {
  let inv = 1;
  for (const s of signals) inv *= 1 - clamp01(s.score) * s.weight;
  return clamp01(1 - inv);
}

/** Decide which of the two entities should survive as the canonical node. */
function orient(a: PersonalEntity, b: PersonalEntity): [PersonalEntity, PersonalEntity] {
  const pa = TYPE_PRIORITY[a.type] ?? 9;
  const pb = TYPE_PRIORITY[b.type] ?? 9;
  if (pa !== pb) return pa < pb ? [a, b] : [b, a];
  // Same type — keep the older record as canonical.
  return a.createdAt <= b.createdAt ? [a, b] : [b, a];
}

// ── Candidate generation (the review queue) ─────────────────────

/**
 * Scan the store for pairs of entities that plausibly describe the same
 * real person and return them as scored candidates, highest confidence
 * first. Pairs the analyst has already rejected are suppressed. Nothing
 * here mutates the store — this is the read side of the review queue.
 */
export function resolveIdentities(store: PersonalStore): IdentityCandidate[] {
  const rejected = new Set((store.identityDecisions || []).map(d => d.pairKey));
  const ents = store.entities.filter(e => IDENTITY_TYPES.includes(e.type));
  const rels = store.relationships;
  const out: IdentityCandidate[] = [];

  for (let i = 0; i < ents.length; i++) {
    for (let j = i + 1; j < ents.length; j++) {
      const a = ents[i];
      const b = ents[j];
      // Anchor every unification on at least one real person.
      if (a.type !== 'person' && b.type !== 'person') continue;

      const pk = pairKeyOf(a.id, b.id);
      if (rejected.has(pk)) continue;

      const signals = buildSignals(a, b, rels);
      if (signals.length === 0) continue;
      const score = fuse(signals);
      if (score < SURFACE_THRESHOLD) continue;

      const [primary, secondary] = orient(a, b);
      out.push({
        id: pk,
        primaryId: primary.id,
        secondaryId: secondary.id,
        primaryLabel: primary.label,
        secondaryLabel: secondary.label,
        primaryType: primary.type,
        secondaryType: secondary.type,
        score,
        signals: signals.sort((s1, s2) => s2.weight * s2.score - s1.weight * s1.score),
      });
    }
  }

  return out.sort((x, y) => y.score - x.score);
}

/** The live review queue: candidates whose entities both still exist. */
export function getReviewQueue(store: PersonalStore): IdentityCandidate[] {
  const ids = new Set(store.entities.map(e => e.id));
  return resolveIdentities(store).filter(c => ids.has(c.primaryId) && ids.has(c.secondaryId));
}

// ── Merge (fold secondary into primary, reversibly) ─────────────

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Fold `secondaryId` into `primaryId`, producing ONE node for the real
 * person. The secondary's identifiers become aliases / linked accounts on
 * the primary, its relationships are re-pointed onto the primary, and a
 * full provenance snapshot is stored so the merge can be split apart later.
 * Returns a NEW store; the input is left untouched.
 */
export function mergeIdentities(
  store: PersonalStore,
  primaryId: string,
  secondaryId: string,
  candidate?: IdentityCandidate,
): PersonalStore {
  if (primaryId === secondaryId) return store;
  const primary = store.entities.find(e => e.id === primaryId);
  const secondary = store.entities.find(e => e.id === secondaryId);
  if (!primary || !secondary) return store;

  // ── Re-point relationships off the secondary onto the primary ──
  const moved: MergeRecord['movedRelationships'] = [];
  const removed: PersonalRelationship[] = [];
  const seen = new Set<string>();
  const nextRels: PersonalRelationship[] = [];

  for (const rel of store.relationships) {
    const touches = rel.sourceId === secondaryId || rel.targetId === secondaryId;
    const newSource = rel.sourceId === secondaryId ? primaryId : rel.sourceId;
    const newTarget = rel.targetId === secondaryId ? primaryId : rel.targetId;

    if (newSource === newTarget) {
      // Folding the two together collapsed this edge into a self-loop.
      if (touches) removed.push(rel);
      else nextRels.push(rel);
      continue;
    }
    const key = `${newSource}:${newTarget}:${rel.label}`;
    if (seen.has(key)) {
      if (touches) removed.push(rel);   // duplicate edge absorbed by the merge
      continue;
    }
    seen.add(key);
    if (touches) {
      const field: 'sourceId' | 'targetId' = rel.sourceId === secondaryId ? 'sourceId' : 'targetId';
      moved.push({ id: rel.id, field, from: secondaryId });
      nextRels.push({ ...rel, sourceId: newSource, targetId: newTarget });
    } else {
      nextRels.push(rel);
    }
  }

  // ── Fuse identifiers into the primary's properties ──
  const recordId = `merge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mergedNames = uniq([...collectNames(primary), ...collectNames(secondary)]);
  const prevProps = primary.properties || {};

  const linkedAccount = {
    recordId,
    type: secondary.type,
    label: secondary.label,
    platform: secondary.properties?.platform || secondary.properties?.network || undefined,
    phones: collectPhones(secondary),
    emails: collectEmails(secondary),
    mergedAt: nowIso(),
  };

  const record: MergeRecord = {
    recordId,
    entity: secondary,
    movedRelationships: moved,
    removedRelationships: removed,
    score: candidate?.score ?? 0,
    signals: candidate?.signals ?? [],
    mergedAt: nowIso(),
  };

  const newPrimary: PersonalEntity = {
    ...primary,
    properties: {
      ...prevProps,
      aliases: uniq([
        ...(Array.isArray(prevProps.aliases) ? prevProps.aliases.map(String) : []),
        ...mergedNames,
      ]).filter(n => normName(n) !== normName(primary.label)),
      phones: uniq([
        ...(Array.isArray(prevProps.phones) ? prevProps.phones.map(String) : []),
        ...collectPhones(primary), ...collectPhones(secondary),
      ]),
      emails: uniq([
        ...(Array.isArray(prevProps.emails) ? prevProps.emails.map(String) : []),
        ...collectEmails(primary), ...collectEmails(secondary),
      ]),
      linkedAccounts: [...(Array.isArray(prevProps.linkedAccounts) ? prevProps.linkedAccounts : []), linkedAccount],
      mergedFrom: [...(Array.isArray(prevProps.mergedFrom) ? prevProps.mergedFrom : []), record],
    },
    tags: uniq([...(primary.tags || []), ...(secondary.tags || [])]),
    coordinates: primary.coordinates || secondary.coordinates,
    updatedAt: nowIso(),
  };

  return {
    ...store,
    entities: store.entities
      .filter(e => e.id !== secondaryId)
      .map(e => (e.id === primaryId ? newPrimary : e)),
    relationships: nextRels,
  };
}

// ── Split (reverse a prior merge) ───────────────────────────────

/** List entities that currently hold folded-in identities (for the UI). */
export function listMergedEntities(store: PersonalStore): { entity: PersonalEntity; records: MergeRecord[] }[] {
  const out: { entity: PersonalEntity; records: MergeRecord[] }[] = [];
  for (const e of store.entities) {
    const records = e.properties?.mergedFrom;
    if (Array.isArray(records) && records.length > 0) out.push({ entity: e, records });
  }
  return out;
}

/**
 * Reverse a single fold: restore the previously merged-out entity and its
 * relationships from the provenance snapshot, and drop the corresponding
 * record / linked-account from the primary. Returns a NEW store.
 */
export function splitIdentity(store: PersonalStore, primaryId: string, recordId: string): PersonalStore {
  const primary = store.entities.find(e => e.id === primaryId);
  if (!primary) return store;
  const records: MergeRecord[] = Array.isArray(primary.properties?.mergedFrom) ? primary.properties.mergedFrom : [];
  const record = records.find(r => r.recordId === recordId);
  if (!record) return store;

  // Restore re-pointed edges back onto the original entity id.
  let rels = store.relationships.map(r => {
    const mv = record.movedRelationships.find(m => m.id === r.id);
    if (mv && r[mv.field] === primaryId) {
      return { ...r, [mv.field]: mv.from };
    }
    return r;
  });
  // Re-add edges the merge had collapsed away.
  const present = new Set(rels.map(r => r.id));
  for (const rr of record.removedRelationships) {
    if (!present.has(rr.id)) rels = [...rels, rr];
  }

  const prevProps = primary.properties || {};
  const newPrimary: PersonalEntity = {
    ...primary,
    properties: {
      ...prevProps,
      mergedFrom: records.filter(r => r.recordId !== recordId),
      linkedAccounts: Array.isArray(prevProps.linkedAccounts)
        ? prevProps.linkedAccounts.filter((a: { recordId?: string }) => a?.recordId !== recordId)
        : prevProps.linkedAccounts,
    },
    updatedAt: nowIso(),
  };

  let entities = store.entities.map(e => (e.id === primaryId ? newPrimary : e));
  if (!entities.some(e => e.id === record.entity.id)) entities = [...entities, record.entity];

  return { ...store, entities, relationships: rels };
}

// ── Reject (suppress a non-match pair) ──────────────────────────

/** Persist "these two are not the same person" so the pair stops resurfacing. */
export function rejectIdentityCandidate(store: PersonalStore, candidate: IdentityCandidate): PersonalStore {
  const decisions = store.identityDecisions || [];
  if (decisions.some(d => d.pairKey === candidate.id)) return store;
  return {
    ...store,
    identityDecisions: [...decisions, { pairKey: candidate.id, decision: 'rejected', at: nowIso() }],
  };
}

/** Clear a previously-rejected pair so it can be reconsidered. */
export function clearIdentityRejection(store: PersonalStore, pairKey: string): PersonalStore {
  const decisions = store.identityDecisions || [];
  if (!decisions.some(d => d.pairKey === pairKey)) return store;
  return { ...store, identityDecisions: decisions.filter(d => d.pairKey !== pairKey) };
}
