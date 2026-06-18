/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Database Backup & Restore
 *
 *  Produces and consumes a portable, self-describing JSON backup of
 *  the ontology data (entities + relationships). The snapshot itself
 *  comes from the entity-store, which works identically against the
 *  Postgres foundation DB or the in-memory fallback — so a backup
 *  taken in one mode restores cleanly in the other.
 *
 *  A backup file carries a magic marker, a schema version and a
 *  SHA-256 checksum over its payload so restores can detect a wrong
 *  or corrupted file before touching the database.
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import { isDBAvailable } from './db';
import {
  exportSnapshot,
  restoreSnapshot,
  getStoreCounts,
  type OntologySnapshot,
} from './entity-store';

export const BACKUP_MAGIC = 'osiris-ontology-backup';
export const BACKUP_VERSION = 1;

export type RestoreMode = 'merge' | 'replace';

export interface BackupFile {
  magic: string;
  version: number;
  createdAt: string;
  source: 'postgres' | 'memory';
  counts: { entities: number; relationships: number };
  /** SHA-256 of the canonical JSON of `data` — integrity guard. */
  checksum: string;
  data: OntologySnapshot;
}

export interface RestoreResult {
  entities: number;
  relationships: number;
  skipped: number;
}

/** Stable checksum over the backup payload. */
function checksum(data: OntologySnapshot): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/** Build a full backup of the current ontology store. */
export async function createBackup(): Promise<BackupFile> {
  const data = await exportSnapshot();
  return {
    magic: BACKUP_MAGIC,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    source: isDBAvailable() ? 'postgres' : 'memory',
    counts: { entities: data.entities.length, relationships: data.relationships.length },
    checksum: checksum(data),
    data,
  };
}

/** Lightweight stats for the backup UI (no full serialisation). */
export async function getBackupMeta(): Promise<{ entities: number; relationships: number; source: 'postgres' | 'memory' }> {
  return getStoreCounts();
}

type ValidationResult = { ok: true; file: BackupFile } | { ok: false; error: string };

/** Validate an uploaded object is a well-formed, uncorrupted OSIRIS backup. */
export function validateBackup(file: unknown): ValidationResult {
  if (!file || typeof file !== 'object') return { ok: false, error: 'Backup is not a valid object' };
  const f = file as Partial<BackupFile>;

  if (f.magic !== BACKUP_MAGIC) return { ok: false, error: 'Not an OSIRIS backup file' };
  if (typeof f.version !== 'number') return { ok: false, error: 'Backup is missing a version' };
  if (f.version > BACKUP_VERSION) {
    return { ok: false, error: `Backup version ${f.version} is newer than this server supports (${BACKUP_VERSION})` };
  }
  if (!f.data || !Array.isArray(f.data.entities) || !Array.isArray(f.data.relationships)) {
    return { ok: false, error: 'Backup payload is missing entities/relationships' };
  }
  // Checksum is best-effort: enforce it when present, tolerate older files without one.
  if (f.checksum && checksum(f.data) !== f.checksum) {
    return { ok: false, error: 'Checksum mismatch — backup file is corrupt or was modified' };
  }

  return { ok: true, file: f as BackupFile };
}

/** Validate then restore a backup. Throws on an invalid file. */
export async function restoreBackup(
  file: unknown,
  mode: RestoreMode = 'merge',
  actor = 'admin'
): Promise<RestoreResult> {
  const v = validateBackup(file);
  if (!v.ok) throw new Error(v.error);
  return restoreSnapshot(v.file.data, mode, actor);
}
