/**
 * ════════════════════════════════════════════════════════════════
 *  OSIRIS — Database Backup & Restore API (admin only)
 *
 *  GET  /api/admin/backup          → download a full JSON backup
 *  GET  /api/admin/backup?meta=1   → current store stats (counts + mode)
 *  POST /api/admin/backup          → restore from an uploaded backup
 *                                    body: { backup, mode: 'merge'|'replace' }
 *
 *  Backs the Backup & Restore tab of the Admin Console.
 * ════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { verifyJWT, getTokenFromRequest } from '@/lib/auth';
import {
  createBackup,
  getBackupMeta,
  restoreBackup,
  type RestoreMode,
} from '@/lib/store/backup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Resolve the caller and require the admin role. */
function requireAdmin(request: Request): { ok: true; username: string } | { ok: false; res: NextResponse } {
  const token = getTokenFromRequest(request);
  if (!token) return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const payload = verifyJWT(token);
  if (!payload) return { ok: false, res: NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 }) };
  if (payload.role !== 'admin') return { ok: false, res: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
  return { ok: true, username: payload.username };
}

/** GET — download a backup, or return store stats with ?meta=1. */
export async function GET(request: Request) {
  const gate = requireAdmin(request);
  if (!gate.ok) return gate.res;

  const { searchParams } = new URL(request.url);

  if (searchParams.get('meta')) {
    try {
      const meta = await getBackupMeta();
      return NextResponse.json(meta);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  try {
    const backup = await createBackup();
    const stamp = backup.createdAt.replace(/[:.]/g, '-');
    return new NextResponse(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="osiris-backup-${stamp}.json"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** POST — restore from an uploaded backup. Body: { backup, mode }. */
export async function POST(request: Request) {
  const gate = requireAdmin(request);
  if (!gate.ok) return gate.res;

  let body: { backup?: unknown; mode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.backup) {
    return NextResponse.json({ error: 'Missing "backup" in request body' }, { status: 400 });
  }
  const mode: RestoreMode = body.mode === 'replace' ? 'replace' : 'merge';

  try {
    const result = await restoreBackup(body.backup, mode, gate.username);
    return NextResponse.json({ success: true, mode, ...result });
  } catch (e) {
    // validateBackup failures (bad/corrupt file) are client errors.
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
