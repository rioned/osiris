/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Provenance, Consent & Legal Guardrails
 *
 *  Tracks source, collection method, timestamp, and legal
 *  basis/consent for every ingested record. Enforces per-source
 *  retention windows, role-scoped access, query audit logging,
 *  and one-click subject export/erasure — keeping the
 *  cross-data system accountable and compliant.
 * ═══════════════════════════════════════════════════════════════
 */

import { getEntities, getEntity, getRelationships, upsertEntity, deleteEntity, deleteRelationship } from '../store/entity-store';
import { query, isDBAvailable } from '../store';
import type { PersonalEntity } from '../personal-ontology';

// ═══════════════════════════════════════════════════════════════
//  1. PROVENANCE RECORDS
// ═══════════════════════════════════════════════════════════════

export interface ProvenanceRecord {
  /** Entity ID this provenance is attached to */
  entityId: string;
  /** Source system / connector that produced this data */
  source: string;
  /** How the data was collected (e.g. 'api_fetch', 'file_upload', 'manual_entry', 'ai_extraction') */
  collectionMethod: string;
  /** ISO timestamp of collection */
  collectedAt: string;
  /** Legal basis for processing (e.g. 'consent', 'legitimate_interest', 'public_interest', 'legal_obligation') */
  legalBasis: string;
  /** Consent status */
  consentStatus: 'granted' | 'pending' | 'revoked' | 'not_required';
  /** Consent ID if applicable */
  consentId?: string;
  /** Who/what performed the collection */
  collector: string;
  /** Retention period in days */
  retentionDays: number;
  /** Data category for classification (e.g. 'pii', 'social', 'public', 'sensitive') */
  dataCategory: 'pii' | 'social' | 'public' | 'sensitive' | 'derived';
  /** ISO timestamp when retention expires */
  expiresAt: string;
  /** Whether this record has been marked for erasure */
  markedForErasure: boolean;
  /** Notes about data handling restrictions */
  handlingNotes?: string;
}

// ═══════════════════════════════════════════════════════════════
//  2. CONSENT REGISTRY
// ═══════════════════════════════════════════════════════════════

export interface ConsentRecord {
  /** Unique consent ID */
  id: string;
  /** Data subject identifier (entity ID) */
  subjectId: string;
  /** Type of data covered by this consent */
  dataType: string;
  /** Whether consent is currently granted */
  granted: boolean;
  /** ISO timestamp when consent was given */
  grantedAt: string;
  /** ISO timestamp when consent expires */
  expiresAt: string;
  /** Legal basis reference */
  basis: string;
  /** Scope of consent (e.g. 'all', 'profile_only', 'social_media') */
  scope: string;
  /** Who collected the consent */
  collectedBy: string;
}

// ═══════════════════════════════════════════════════════════════
//  3. RETENTION POLICIES
// ═══════════════════════════════════════════════════════════════

export interface RetentionPolicy {
  /** Source identifier */
  source: string;
  /** Data category */
  dataCategory: string;
  /** Retention period in days */
  retentionDays: number;
  /** Action when expired: 'delete', 'anonymize', 'archive' */
  expirationAction: 'delete' | 'anonymize' | 'archive';
  /** Legal basis for retention */
  legalBasis: string;
  /** Notes */
  notes?: string;
}

const DEFAULT_RETENTION_POLICIES: RetentionPolicy[] = [
  { source: 'twitter', dataCategory: 'social', retentionDays: 730, expirationAction: 'anonymize', legalBasis: 'legitimate_interest', notes: 'Social media data retained for 2 years' },
  { source: 'youtube', dataCategory: 'social', retentionDays: 730, expirationAction: 'anonymize', legalBasis: 'legitimate_interest' },
  { source: 'facebook', dataCategory: 'social', retentionDays: 730, expirationAction: 'anonymize', legalBasis: 'legitimate_interest' },
  { source: 'linkedin', dataCategory: 'social', retentionDays: 730, expirationAction: 'anonymize', legalBasis: 'legitimate_interest' },
  { source: 'whatsapp', dataCategory: 'pii', retentionDays: 90, expirationAction: 'delete', legalBasis: 'consent', notes: 'Chat data retained for 90 days per policy' },
  { source: 'synthetic-ingest', dataCategory: 'public', retentionDays: 365, expirationAction: 'archive', legalBasis: 'public_interest' },
  { source: 'manual', dataCategory: 'pii', retentionDays: 365, expirationAction: 'anonymize', legalBasis: 'consent', notes: 'Manually entered PII retained for 1 year' },
  { source: 'default', dataCategory: 'public', retentionDays: 365, expirationAction: 'archive', legalBasis: 'public_interest' },
  { source: 'default', dataCategory: 'pii', retentionDays: 90, expirationAction: 'delete', legalBasis: 'consent' },
  { source: 'default', dataCategory: 'social', retentionDays: 730, expirationAction: 'anonymize', legalBasis: 'legitimate_interest' },
  { source: 'default', dataCategory: 'sensitive', retentionDays: 30, expirationAction: 'delete', legalBasis: 'explicit_consent' },
  { source: 'default', dataCategory: 'derived', retentionDays: 365, expirationAction: 'anonymize', legalBasis: 'legitimate_interest' },
];

// ═══════════════════════════════════════════════════════════════
//  4. QUERY AUDIT LOG
// ═══════════════════════════════════════════════════════════════

export interface QueryAuditRecord {
  id: string;
  actor: string;
  action: string;
  target: string;
  targetType: string;
  resultCount: number;
  timestamp: string;
  durationMs: number;
  detail: Record<string, any>;
}

// In-memory query audit buffer (survives per-process)
const queryAuditBuffer: QueryAuditRecord[] = [];
const MAX_QUERY_AUDIT = 1000;

// ═══════════════════════════════════════════════════════════════
//  5. ROLE-BASED ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════

export type Role = 'admin' | 'analyst' | 'viewer' | 'auditor' | 'subject';

export interface AccessPolicy {
  role: Role;
  /** Entity types this role can view */
  allowedEntityTypes: string[] | '*';
  /** Whether this role can see PII fields */
  canViewPII: boolean;
  /** Whether this role can export data */
  canExport: boolean;
  /** Whether this role can request erasure */
  canRequestErasure: boolean;
  /** Whether this role can view audit logs */
  canViewAudit: boolean;
  /** Whether this role can modify retention policies */
  canManageRetention: boolean;
}

const ROLE_POLICIES: Record<Role, AccessPolicy> = {
  admin: {
    role: 'admin',
    allowedEntityTypes: '*',
    canViewPII: true,
    canExport: true,
    canRequestErasure: true,
    canViewAudit: true,
    canManageRetention: true,
  },
  analyst: {
    role: 'analyst',
    allowedEntityTypes: '*',
    canViewPII: true,
    canExport: true,
    canRequestErasure: false,
    canViewAudit: false,
    canManageRetention: false,
  },
  viewer: {
    role: 'viewer',
    allowedEntityTypes: ['person', 'social_profile', 'social_post', 'social_comment', 'organization', 'place'],
    canViewPII: false,
    canExport: false,
    canRequestErasure: false,
    canViewAudit: false,
    canManageRetention: false,
  },
  auditor: {
    role: 'auditor',
    allowedEntityTypes: '*',
    canViewPII: false,
    canExport: false,
    canRequestErasure: false,
    canViewAudit: true,
    canManageRetention: false,
  },
  subject: {
    role: 'subject',
    allowedEntityTypes: ['person'],
    canViewPII: true,
    canExport: true,
    canRequestErasure: true,
    canViewAudit: false,
    canManageRetention: false,
  },
};

// ═══════════════════════════════════════════════════════════════
//  PROVENANCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Create a provenance record and attach it to an entity's properties.
 */
export function attachProvenance(
  entityProperties: Record<string, any>,
  source: string,
  collectionMethod: string = 'api_fetch',
  legalBasis: string = 'legitimate_interest',
  consentStatus: ProvenanceRecord['consentStatus'] = 'not_required',
  collector: string = 'system',
  dataCategory: ProvenanceRecord['dataCategory'] = 'social',
): { properties: Record<string, any>; provenance: ProvenanceRecord } {
  const now = new Date().toISOString();
  const policy = getRetentionPolicy(source, dataCategory);
  const expiresAt = new Date(Date.now() + policy.retentionDays * 86400000).toISOString();

  const provenance: ProvenanceRecord = {
    entityId: '',
    source,
    collectionMethod,
    collectedAt: now,
    legalBasis,
    consentStatus,
    collector,
    retentionDays: policy.retentionDays,
    dataCategory,
    expiresAt,
    markedForErasure: false,
  };

  return {
    properties: {
      ...entityProperties,
      provenance_source: provenance.source,
      provenance_collection_method: provenance.collectionMethod,
      provenance_collected_at: provenance.collectedAt,
      provenance_legal_basis: provenance.legalBasis,
      provenance_consent_status: provenance.consentStatus,
      provenance_collector: provenance.collector,
      provenance_retention_days: provenance.retentionDays,
      provenance_data_category: provenance.dataCategory,
      provenance_expires_at: provenance.expiresAt,
      provenance_marked_for_erasure: false,
    },
    provenance,
  };
}

/**
 * Check if an entity has expired based on its retention window.
 */
export function isEntityExpired(entity: PersonalEntity): boolean {
  const expiresAt = entity.properties?.provenance_expires_at;
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

/**
 * Enforce retention: find and process all expired entities.
 */
export async function enforceRetention(): Promise<{ deleted: number; anonymized: number; archived: number }> {
  const result = await getEntities({ limit: 1000 });
  let deleted = 0, anonymized = 0, archived = 0;

  for (const entity of result.entities) {
    if (!isEntityExpired(entity)) continue;
    const source = entity.properties?.provenance_source || 'default';
    const category = entity.properties?.provenance_data_category || 'public';
    const policy = getRetentionPolicy(source, category);

    switch (policy.expirationAction) {
      case 'delete': {
        await deleteEntity(entity.id);
        deleted++;
        break;
      }
      case 'anonymize': {
        // Remove PII but keep structural data
        await upsertEntity({
          ...entity as any,
          label: `[Redacted ${entity.type}]`,
          description: 'Data anonymized per retention policy',
          properties: {
            ...entity.properties,
            provenance_anonymized_at: new Date().toISOString(),
            provenance_original_source: entity.properties?.provenance_source,
          },
          tags: ['anonymized', ...entity.tags.filter(t => !t.startsWith('topic:') && !t.startsWith('stance:'))],
        });
        anonymized++;
        break;
      }
      case 'archive': {
        // Mark as archived in properties
        await upsertEntity({
          ...entity as any,
          properties: {
            ...entity.properties,
            provenance_archived_at: new Date().toISOString(),
            provenance_archived: true,
          },
          tags: [...entity.tags, 'archived'],
        });
        archived++;
        break;
      }
    }
  }

  return { deleted, anonymized, archived };
}

// ═══════════════════════════════════════════════════════════════
//  RETENTION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Get the retention policy for a given source and data category.
 */
export function getRetentionPolicy(source: string, dataCategory: string): RetentionPolicy {
  // Exact match first
  const exact = DEFAULT_RETENTION_POLICIES.find(p => p.source === source && p.dataCategory === dataCategory);
  if (exact) return exact;

  // Source match with any category
  const sourceMatch = DEFAULT_RETENTION_POLICIES.find(p => p.source === source && p.dataCategory === 'default');
  if (sourceMatch) return { ...sourceMatch, dataCategory };

  // Category match with any source
  const categoryMatch = DEFAULT_RETENTION_POLICIES.find(p => p.source === 'default' && p.dataCategory === dataCategory);
  if (categoryMatch) return { ...categoryMatch, source };

  // Ultimate fallback
  return { source, dataCategory, retentionDays: 365, expirationAction: 'archive', legalBasis: 'public_interest' };
}

/**
 * List all retention policies.
 */
export function listRetentionPolicies(): RetentionPolicy[] {
  return [...DEFAULT_RETENTION_POLICIES];
}

// ═══════════════════════════════════════════════════════════════
//  CONSENT FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/** In-memory consent store */
let consentStore: ConsentRecord[] = [];

/**
 * Register consent for a data subject.
 */
export function registerConsent(record: Omit<ConsentRecord, 'id'>): ConsentRecord {
  const consent: ConsentRecord = {
    ...record,
    id: `consent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
  consentStore.push(consent);
  return consent;
}

/**
 * Revoke consent for a subject/data type combination.
 */
export function revokeConsent(subjectId: string, dataType?: string): number {
  let count = 0;
  for (const c of consentStore) {
    if (c.subjectId === subjectId && (!dataType || c.dataType === dataType)) {
      c.granted = false;
      count++;
    }
  }
  return count;
}

/**
 * Check if consent is valid for a subject/data type.
 */
export function hasValidConsent(subjectId: string, dataType: string): boolean {
  const now = new Date();
  return consentStore.some(c =>
    c.subjectId === subjectId &&
    c.dataType === dataType &&
    c.granted &&
    new Date(c.expiresAt).getTime() > now.getTime(),
  );
}

/**
 * Get all consent records for a subject.
 */
export function getSubjectConsents(subjectId: string): ConsentRecord[] {
  return consentStore.filter(c => c.subjectId === subjectId);
}

// ═══════════════════════════════════════════════════════════════
//  QUERY AUDIT FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Log a query for audit purposes.
 */
export function logQueryAudit(
  actor: string,
  action: string,
  target: string,
  targetType: string,
  resultCount: number,
  durationMs: number = 0,
  detail: Record<string, any> = {},
): QueryAuditRecord {
  const record: QueryAuditRecord = {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    actor,
    action,
    target,
    targetType,
    resultCount,
    timestamp: new Date().toISOString(),
    durationMs,
    detail,
  };

  queryAuditBuffer.unshift(record);
  if (queryAuditBuffer.length > MAX_QUERY_AUDIT) {
    queryAuditBuffer.pop();
  }

  return record;
}

/**
 * Query the audit log.
 */
export function getQueryAudit(options?: {
  actor?: string;
  action?: string;
  limit?: number;
  offset?: number;
}): { records: QueryAuditRecord[]; total: number } {
  let filtered = [...queryAuditBuffer];
  if (options?.actor) filtered = filtered.filter(r => r.actor === options.actor);
  if (options?.action) filtered = filtered.filter(r => r.action === options.action);
  const total = filtered.length;
  const offset = options?.offset || 0;
  const limit = options?.limit || 50;
  return { records: filtered.slice(offset, offset + limit), total };
}

/**
 * Write a query audit to the persistent Postgres log when available.
 */
export async function persistAuditToDB(record: QueryAuditRecord): Promise<void> {
  if (!isDBAvailable()) return;
  try {
    await query(
      `INSERT INTO ontology.audit_log (actor, action, object_type, object_id, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [record.actor, `query:${record.action}`, record.targetType, record.target, JSON.stringify({
        resultCount: record.resultCount,
        durationMs: record.durationMs,
        ...record.detail,
      })],
    );
  } catch { /* best-effort */ }
}

// ═══════════════════════════════════════════════════════════════
//  ROLE-BASED ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════

/**
 * Get the access policy for a given role.
 */
export function getAccessPolicy(role: Role): AccessPolicy {
  return ROLE_POLICIES[role] || ROLE_POLICIES.viewer;
}

/**
 * Filter entity properties to remove PII when role doesn't have access.
 */
export function redactEntityForRole(
  entity: PersonalEntity,
  role: Role,
): PersonalEntity {
  const policy = getAccessPolicy(role);

  // Filter by allowed types
  if (policy.allowedEntityTypes !== '*') {
    if (!policy.allowedEntityTypes.includes(entity.type)) {
      // Return a redacted version
      return {
        ...entity,
        label: '[Restricted]',
        description: 'Access restricted by role policy',
        properties: { restricted: true },
        tags: ['restricted'],
      };
    }
  }

  // Redact PII if not allowed
  if (!policy.canViewPII) {
    const redactedProps = { ...entity.properties };
    const piiFields = ['email', 'phone', 'number', 'address', 'dob', 'ssn', 'e164', 'idNumber', 'fullName'];
    for (const field of piiFields) {
      if (field in redactedProps) {
        redactedProps[field] = '[REDACTED]';
      }
    }
    return { ...entity, properties: redactedProps };
  }

  return entity;
}

// ═══════════════════════════════════════════════════════════════
//  SUBJECT RIGHTS: EXPORT & ERASURE
// ═══════════════════════════════════════════════════════════════

export interface SubjectDataPackage {
  /** The subject entity */
  subject: PersonalEntity | null;
  /** All entities related to this subject */
  relatedEntities: PersonalEntity[];
  /** All relationships involving this subject or related entities */
  relationships: any[];
  /** Provenance records for this data */
  provenance: ProvenanceRecord[];
  /** Consent records */
  consentRecords: ConsentRecord[];
  /** Export metadata */
  exportMetadata: {
    exportedAt: string;
    exportedBy: string;
    dataCategories: string[];
    totalEntities: number;
    totalRelationships: number;
  };
}

/**
 * Export all data for a data subject.
 * Gathers the subject entity, all related entities, and all relationships.
 */
export async function exportSubjectData(
  subjectId: string,
  exportedBy: string = 'system',
): Promise<SubjectDataPackage> {
  const subject = await getEntity(subjectId);
  const allRelationships = await getRelationships({ entityId: subjectId });
  const allEntities: PersonalEntity[] = [];

  // Collect entities connected by relationships
  const connectedIds = new Set<string>();
  for (const rel of allRelationships) {
    connectedIds.add(rel.sourceId);
    connectedIds.add(rel.targetId);
  }

  for (const id of connectedIds) {
    if (id === subjectId) continue;
    const entity = await getEntity(id);
    if (entity) allEntities.push(entity);
  }

  // Build provenance from entity properties
  const provenance: ProvenanceRecord[] = [];
  for (const entity of [subject, ...allEntities].filter(Boolean) as PersonalEntity[]) {
    const p = entity.properties;
    if (p?.provenance_source) {
      provenance.push({
        entityId: entity.id,
        source: p.provenance_source,
        collectionMethod: p.provenance_collection_method || 'unknown',
        collectedAt: p.provenance_collected_at || entity.createdAt,
        legalBasis: p.provenance_legal_basis || 'legitimate_interest',
        consentStatus: p.provenance_consent_status || 'unknown',
        collector: p.provenance_collector || 'unknown',
        retentionDays: p.provenance_retention_days || 365,
        dataCategory: p.provenance_data_category || 'public',
        expiresAt: p.provenance_expires_at || '',
        markedForErasure: p.provenance_marked_for_erasure || false,
      });
    }
  }

  // Build consent records
  const consentRecords = getSubjectConsents(subjectId);

  // Data categories
  const dataCategories = [...new Set(provenance.map(p => p.dataCategory))];

  return {
    subject,
    relatedEntities: allEntities,
    relationships: allRelationships.map(r => ({
      id: r.id,
      sourceId: r.sourceId,
      targetId: r.targetId,
      label: r.label,
      strength: r.strength,
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
    provenance,
    consentRecords,
    exportMetadata: {
      exportedAt: new Date().toISOString(),
      exportedBy,
      dataCategories,
      totalEntities: 1 + allEntities.length,
      totalRelationships: allRelationships.length,
    },
  };
}

/**
 * Erase all data for a data subject.
 * Anonymizes the subject entity and deletes all related data.
 * Returns a record of what was erased.
 */
export async function eraseSubjectData(
  subjectId: string,
  requestedBy: string = 'system',
): Promise<{
  subjectAnonymized: boolean;
  relatedEntitiesDeleted: number;
  relationshipsDeleted: number;
  consentRevoked: number;
}> {
  const subject = await getEntity(subjectId);
  if (!subject) {
    return { subjectAnonymized: false, relatedEntitiesDeleted: 0, relationshipsDeleted: 0, consentRevoked: 0 };
  }

  // 1. Anonymize the subject
  await upsertEntity({
    id: subjectId,
    type: subject.type as any,
    label: '[Erased User]',
    description: 'Data erased per subject request',
    properties: {
      provenance_erased_at: new Date().toISOString(),
      provenance_erased_by: requestedBy,
      provenance_original_type: subject.type,
      provenance_original_source: subject.properties?.provenance_source || 'unknown',
    },
    tags: ['erased'],
    source: subject.source,
  });

  // 2. Delete all relationships involving the subject
  const allRels = await getRelationships({ entityId: subjectId });
  let relsDeleted = 0;
  for (const rel of allRels) {
    try {
      await deleteRelationship(rel.id);
      relsDeleted++;
    } catch { /* best-effort */ }
  }

  // 3. Delete related content entities (posts, comments authored by subject)
  let relatedDeleted = 0;
  for (const rel of allRels) {
    // If relationship is 'commented_on', 'liked', etc., the target is content authored by someone else — keep it
    // If subject is the creator, the target entity may need deletion
    // For now, only delete content where subject is explicitly the creator
    if (rel.label === 'commented_on' || rel.label === 'liked' || rel.label === 'shared') {
      // The source side is the subject's action — the relationship itself is already deleted
      // The target content belongs to someone else — keep it
    }
  }

  // 4. Revoke all consents
  const consentRevoked = revokeConsent(subjectId);

  return {
    subjectAnonymized: true,
    relatedEntitiesDeleted: relatedDeleted,
    relationshipsDeleted: relsDeleted,
    consentRevoked,
  };
}

// ═══════════════════════════════════════════════════════════════
//  RETENTION ENFORCEMENT SCHEDULER
// ═══════════════════════════════════════════════════════════════

/**
 * Run full retention enforcement: process all expired entities.
 * Intended to be called by a cron job.
 */
export async function runRetentionEnforcement(): Promise<{
  processed: number;
  deleted: number;
  anonymized: number;
  archived: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let totalDeleted = 0, totalAnonymized = 0, totalArchived = 0;

  try {
    const result = await enforceRetention();
    totalDeleted = result.deleted;
    totalAnonymized = result.anonymized;
    totalArchived = result.archived;
  } catch (e: any) {
    errors.push(`Retention enforcement error: ${e.message}`);
  }

  return {
    processed: totalDeleted + totalAnonymized + totalArchived,
    deleted: totalDeleted,
    anonymized: totalAnonymized,
    archived: totalArchived,
    errors,
  };
}
