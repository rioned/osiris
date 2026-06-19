/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Provenance, Consent & Legal Guardrails API
 *
 *  Provenance:
 *    GET  /api/governance/provenance?entityId=xxx  — get provenance
 *    POST /api/governance/provenance               — attach provenance
 *
 *  Retention:
 *    GET  /api/governance/retention            — list policies
 *    POST /api/governance/retention/enforce    — enforce retention
 *
 *  Consent:
 *    GET  /api/governance/consent?subjectId=xxx   — get consents
 *    POST /api/governance/consent/register         — register consent
 *    POST /api/governance/consent/revoke           — revoke consent
 *
 *  Audit:
 *    GET  /api/governance/audit                — query audit log
 *
 *  Subject Rights:
 *    GET  /api/governance/export?entityId=xxx  — export subject data
 *    POST /api/governance/erasure              — erase subject data
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  attachProvenance,
  listRetentionPolicies,
  runRetentionEnforcement,
  registerConsent,
  revokeConsent,
  getSubjectConsents,
  logQueryAudit,
  getQueryAudit,
  exportSubjectData,
  eraseSubjectData,
  redactEntityForRole,
  getAccessPolicy,
  type Role,
} from '@/lib/governance/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const section = searchParams.get('section') || '';
    const entityId = searchParams.get('entityId') || '';
    const subjectId = searchParams.get('subjectId') || '';
    const actor = searchParams.get('actor') || 'anonymous';
    const role = (searchParams.get('role') || 'viewer') as Role;
    const action = searchParams.get('action') || '';

    switch (section) {
      case 'provenance': {
        if (!entityId) {
          return NextResponse.json({ error: 'entityId required' }, { status: 400 });
        }
        const { getEntity } = await import('@/lib/store/entity-store');
        const entity = await getEntity(entityId);
        if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
        const provenance = {
          source: entity.properties?.provenance_source,
          collectionMethod: entity.properties?.provenance_collection_method,
          collectedAt: entity.properties?.provenance_collected_at,
          legalBasis: entity.properties?.provenance_legal_basis,
          consentStatus: entity.properties?.provenance_consent_status,
          collector: entity.properties?.provenance_collector,
          retentionDays: entity.properties?.provenance_retention_days,
          dataCategory: entity.properties?.provenance_data_category,
          expiresAt: entity.properties?.provenance_expires_at,
          markedForErasure: entity.properties?.provenance_marked_for_erasure,
        };

        logQueryAudit(actor, 'read_provenance', entityId, 'provenance', 1);
        return NextResponse.json({ success: true, entityId, provenance });
      }

      case 'retention': {
        const policies = listRetentionPolicies();
        logQueryAudit(actor, 'list_retention_policies', 'all', 'retention', policies.length);
        return NextResponse.json({ success: true, count: policies.length, policies });
      }

      case 'consent': {
        if (!subjectId) {
          return NextResponse.json({ error: 'subjectId required' }, { status: 400 });
        }
        const consents = getSubjectConsents(subjectId);
        logQueryAudit(actor, 'read_consent', subjectId, 'consent', consents.length);
        return NextResponse.json({ success: true, subjectId, count: consents.length, consents });
      }

      case 'audit': {
        const limit = parseInt(searchParams.get('limit') || '50', 10);
        const offset = parseInt(searchParams.get('offset') || '0', 10);
        const filterActor = searchParams.get('filterActor') || undefined;
        const filterAction = searchParams.get('filterAction') || undefined;
        const result = getQueryAudit({ actor: filterActor, action: filterAction, limit, offset });
        return NextResponse.json({ success: true, ...result });
      }

      case 'export': {
        if (!entityId) {
          return NextResponse.json({ error: 'entityId required' }, { status: 400 });
        }
        // Check role
        const policy = getAccessPolicy(role);
        if (!policy.canExport) {
          logQueryAudit(actor, 'export_denied', entityId, 'export', 0, 0, { reason: 'insufficient_role', role });
          return NextResponse.json({ error: 'Export not permitted for this role' }, { status: 403 });
        }
        const data = await exportSubjectData(entityId, actor);
        logQueryAudit(actor, 'export', entityId, 'export', data.exportMetadata.totalEntities);
        return NextResponse.json({ success: true, ...data });
      }

      default: {
        return NextResponse.json({
          name: 'OSIRIS Governance',
          sections: {
            provenance: 'GET /api/governance?section=provenance&entityId=xxx',
            retention: 'GET /api/governance?section=retention',
            consent: 'GET /api/governance?section=consent&subjectId=xxx',
            audit: 'GET /api/governance?section=audit',
            export: 'GET /api/governance?section=export&entityId=xxx&role=admin',
          },
        });
      }
    }
  } catch (e: any) {
    console.error('[Governance] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || '';
    const actor = body.actor || 'system';
    const role = (body.role || 'admin') as Role;

    switch (action) {
      case 'attach-provenance': {
        const entityId = body.entityId;
        if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });
        const { getEntity, upsertEntity } = await import('@/lib/store/entity-store');
        const entity = await getEntity(entityId);
        if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
        const { properties } = attachProvenance(
          entity.properties || {},
          body.source || entity.source,
          body.collectionMethod || 'manual_entry',
          body.legalBasis || 'consent',
          body.consentStatus || 'pending',
          actor,
          body.dataCategory || 'pii',
        );
        await upsertEntity({ ...entity, properties } as any);
        logQueryAudit(actor, 'attach_provenance', entityId, 'provenance', 1);
        return NextResponse.json({ success: true, entityId });
      }

      case 'enforce-retention': {
        const policy = getAccessPolicy(role);
        if (!policy.canManageRetention) {
          return NextResponse.json({ error: 'Not permitted to manage retention' }, { status: 403 });
        }
        const result = await runRetentionEnforcement();
        logQueryAudit(actor, 'enforce_retention', 'all', 'retention', result.processed);
        return NextResponse.json({ success: true, ...result });
      }

      case 'register-consent': {
        const { subjectId, dataType, basis, scope } = body;
        if (!subjectId || !dataType) {
          return NextResponse.json({ error: 'subjectId and dataType required' }, { status: 400 });
        }
        const consent = registerConsent({
          subjectId,
          dataType,
          granted: true,
          grantedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
          basis: basis || 'explicit_consent',
          scope: scope || 'all',
          collectedBy: actor,
        });
        logQueryAudit(actor, 'register_consent', subjectId, 'consent', 1);
        return NextResponse.json({ success: true, consent });
      }

      case 'revoke-consent': {
        const { subjectId: revokeSubject, dataType: revokeType } = body;
        if (!revokeSubject) return NextResponse.json({ error: 'subjectId required' }, { status: 400 });
        const count = revokeConsent(revokeSubject, revokeType);
        logQueryAudit(actor, 'revoke_consent', revokeSubject, 'consent', count);
        return NextResponse.json({ success: true, revokedCount: count });
      }

      case 'erasure': {
        const eraseEntityId = body.entityId;
        if (!eraseEntityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });
        const policy = getAccessPolicy(role);
        if (!policy.canRequestErasure) {
          return NextResponse.json({ error: 'Erasure not permitted for this role' }, { status: 403 });
        }
        const result = await eraseSubjectData(eraseEntityId, actor);
        logQueryAudit(actor, 'erasure', eraseEntityId, 'erasure', result.subjectAnonymized ? 1 : 0);
        return NextResponse.json({ success: true, ...result });
      }

      default:
        return NextResponse.json({
          actions: {
            'attach-provenance': 'Attach provenance metadata to an entity',
            'enforce-retention': 'Run retention enforcement',
            'register-consent': 'Register consent for a subject',
            'revoke-consent': 'Revoke consent for a subject',
            'erasure': 'Erase all data for a subject',
          },
        });
    }
  } catch (e: any) {
    console.error('[Governance] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
