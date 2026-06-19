'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Admin Console
 *  Admin-only panel with capabilities:
 *
 *   1. User Management — list accounts, change role tiers
 *   2. Live Ontology Builder — manual link-analysis against server graph
 *   3. Social Media Connectors — mass-data ingestion suite with
 *      X/Twitter, YouTube, Facebook, LinkedIn, WhatsApp connectors
 *      plus bulk importers (person IDs, phone contacts, rosters).
 *      Each connector fetches raw social data, structures it with
 *      full metadata, and sends it to /api/ai/ontology-query (ingest)
 *      for AI-driven entity + relationship extraction.
 * ═══════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import dynamic from 'next/dynamic';
import {
  X, Shield, Users, Network, Plus, RefreshCw, Loader2, Zap, Radio,
  Database, Upload, Search, Globe, MessageSquare, Share2, UserCheck,
  Link, FileText, ChevronDown, ChevronRight, CheckCircle2, AlertCircle,
  Clock, Eye, EyeOff, Download, Trash2, Copy, Bird as Twitter, Video, BookOpen,
  Briefcase, Phone, Bot, HardDriveDownload, RotateCcw, FileJson, AlertTriangle,
} from 'lucide-react';
import { useAuth, type UserRole } from './AuthProvider';
import {
  PersonalEntity, PersonalRelationship, PersonalEntityType,
  PERSONAL_TYPE_COLORS, PERSONAL_TYPE_LABELS, generateEntityId,
} from '@/lib/personal-ontology';
import { useOntologyTypes } from '@/lib/useOntologyTypes';
import IdentityTab from './IdentityTab';

const LinkEditorGraph = dynamic(() => import('./LinkEditorGraph'), { ssr: false });

type AdminTab = 'users' | 'ontology' | 'connectors' | 'backup' | 'identity';
type ConnectorTab = 'twitter' | 'youtube' | 'facebook' | 'linkedin' | 'whatsapp' | 'bulk-import';
type BulkImportType = 'person-ids' | 'phone-contacts' | 'persons-and-jobs';

const ROLES: UserRole[] = ['viewer', 'analyst', 'admin'];
const ROLE_COLORS: Record<UserRole, string> = { viewer: '#00E676', analyst: '#4FC3F7', admin: '#FF3D3D' };

const CONNECTOR_TABS: { key: ConnectorTab; label: string; icon: any; color: string }[] = [
  { key: 'twitter', label: 'X / TWITTER', icon: Twitter, color: '#1DA1F2' },
  { key: 'youtube', label: 'YOUTUBE', icon: Video, color: '#FF0000' },
  { key: 'facebook', label: 'FACEBOOK', icon: Share2, color: '#1877F2' },
  { key: 'linkedin', label: 'LINKEDIN', icon: Briefcase, color: '#0A66C2' },
  { key: 'whatsapp', label: 'WHATSAPP', icon: MessageSquare, color: '#25D366' },
  { key: 'bulk-import', label: 'BULK IMPORTERS', icon: Database, color: '#D4AF37' },
];

const CONNECTOR_ACTIONS: Record<ConnectorTab, { value: string; label: string; description: string }[]> = {
  twitter: [
    { value: 'fetch-profile', label: 'Fetch Profile', description: 'Biography, followers, following, joined date, location' },
    { value: 'fetch-tweets', label: 'Fetch Tweets', description: 'Recent tweets with likes, retweets, replies, media, hashtags' },
    { value: 'fetch-thread', label: 'Fetch Thread', description: 'Thread + all replies with metadata' },
    { value: 'fetch-followers', label: 'Fetch Followers', description: 'Follower list with bios, join dates, locations' },
    { value: 'fetch-following', label: 'Fetch Following', description: 'Following list with bios, locations' },
    { value: 'search', label: 'Search', description: 'Search tweets by keyword query' },
    { value: 'ingest-all', label: 'Ingest All → Ontology', description: 'Profile + tweets + followers, batch extracted' },
  ],
  youtube: [
    { value: 'fetch-channel', label: 'Fetch Channel', description: 'Channel info + video list with stats' },
    { value: 'fetch-video', label: 'Fetch Video', description: 'Video details + comments + replies' },
    { value: 'fetch-comments', label: 'Fetch Comments', description: 'Comments + replies for a video' },
    { value: 'search', label: 'Search', description: 'Search videos by query' },
    { value: 'ingest-all', label: 'Ingest All → Ontology', description: 'Channel + videos + comments batch extracted' },
  ],
  facebook: [
    { value: 'fetch-page', label: 'Fetch Page', description: 'Page info, posts, likes, shares, comments' },
    { value: 'fetch-posts', label: 'Fetch Posts', description: 'Recent posts with reactions, shares' },
    { value: 'fetch-comments', label: 'Fetch Comments', description: 'Comments + reactions on a post' },
    { value: 'fetch-groups', label: 'Fetch Groups', description: 'Group info + membership + posts' },
  ],
  linkedin: [
    { value: 'fetch-profile', label: 'Fetch Profile', description: 'Profile, experience, education, skills' },
    { value: 'fetch-posts', label: 'Fetch Posts', description: 'Profile/company posts with engagement' },
    { value: 'fetch-comments', label: 'Fetch Comments', description: 'Comments on a post with reactions' },
    { value: 'fetch-company', label: 'Fetch Company', description: 'Company page, updates, employee count' },
  ],
  whatsapp: [
    { value: 'ingest-chat', label: 'Ingest Chat Export', description: 'Parse WhatsApp .txt export → ontology' },
    { value: 'ingest-media-log', label: 'Ingest Media Log', description: 'Parse media metadata → ontology' },
    { value: 'ingest-all', label: 'Ingest All', description: 'Chat + media batch import' },
  ],
  'bulk-import': [
    { value: 'person-ids', label: 'Person IDs', description: 'Name, ID type, number, country, DOB, nationality' },
    { value: 'phone-contacts', label: 'Phone Contacts', description: 'Name, phone, email, address, organization, tags' },
    { value: 'persons-and-jobs', label: 'Persons & Jobs', description: 'Name, title, company, department, manager, linkedin' },
  ],
};

const BULK_TEMPLATES: Record<BulkImportType, { headers: string[]; sample: string }> = {
  'person-ids': {
    headers: ['person_name', 'id_type', 'id_number', 'country', 'dob', 'nationality', 'notes'],
    sample: 'John Smith,Passport,AB123456,United Kingdom,1985-03-15,British,Subject of interest',
  },
  'phone-contacts': {
    headers: ['contact_name', 'phone_number', 'email', 'address', 'city', 'country', 'organization', 'notes'],
    sample: 'Jane Doe,+447700900000,jane@example.com,123 High St,London,UK,Acme Corp,Supplier contact',
  },
  'persons-and-jobs': {
    headers: ['person_name', 'job_title', 'company', 'department', 'email', 'phone', 'linkedin', 'location', 'reports_to', 'notes'],
    sample: 'Alice Brown,CTO,TechCorp,Engineering,alice@techcorp.com,+447700900001,linkedin.com/in/alice,London,Bob CEO,Executive team',
  },
};

interface AdminUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

interface Props {
  show: boolean;
  onClose: () => void;
}

export default function AdminPanel({ show, onClose }: Props) {
  const { token, user, hasRole } = useAuth();
  const [tab, setTab] = useState<AdminTab>('users');

  if (!show) return null;
  if (!hasRole('admin')) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[450] flex flex-col"
      style={{ background: 'radial-gradient(ellipse at center, #0a0a14 0%, #050508 100%)' }}
    >
      {/* HEADER */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-black/40 shrink-0">
        <div className="flex items-center gap-3">
          <Shield className="w-4 h-4 text-[#FF3D3D]" />
          <span className="text-[12px] font-mono font-bold tracking-[0.2em] text-[#FF3D3D]">ADMIN CONSOLE</span>
          <span className="text-[9px] font-mono text-white/40">SIGNED IN AS {user?.username?.toUpperCase()}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded overflow-hidden border border-white/10">
            <button onClick={() => setTab('users')}
              className="flex items-center gap-1 px-3 py-1.5 text-[8px] font-mono transition-colors"
              style={{
                backgroundColor: tab === 'users' ? 'rgba(255,61,61,0.15)' : 'rgba(255,255,255,0.03)',
                color: tab === 'users' ? '#FF3D3D' : 'rgba(255,255,255,0.5)',
              }}>
              <Users className="w-3 h-3" /> USERS
            </button>
            <button onClick={() => setTab('ontology')}
              className="flex items-center gap-1 px-3 py-1.5 text-[8px] font-mono transition-colors"
              style={{
                backgroundColor: tab === 'ontology' ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.03)',
                color: tab === 'ontology' ? '#00E5FF' : 'rgba(255,255,255,0.5)',
              }}>
              <Network className="w-3 h-3" /> ONTOLOGY BUILDER
            </button>
            <button onClick={() => setTab('connectors')}
              className="flex items-center gap-1 px-3 py-1.5 text-[8px] font-mono transition-colors"
              style={{
                backgroundColor: tab === 'connectors' ? 'rgba(212,175,55,0.15)' : 'rgba(255,255,255,0.03)',
                color: tab === 'connectors' ? '#D4AF37' : 'rgba(255,255,255,0.5)',
              }}>
              <Database className="w-3 h-3" /> CONNECTORS
            </button>
            <button onClick={() => setTab('backup')}
              className="flex items-center gap-1 px-3 py-1.5 text-[8px] font-mono transition-colors"
              style={{
                backgroundColor: tab === 'backup' ? 'rgba(59,167,118,0.15)' : 'rgba(255,255,255,0.03)',
                color: tab === 'backup' ? '#3BA776' : 'rgba(255,255,255,0.5)',
              }}>
              <HardDriveDownload className="w-3 h-3" /> BACKUP &amp; RESTORE
            </button>
            <button onClick={() => setTab('identity')}
              className="flex items-center gap-1 px-3 py-1.5 text-[8px] font-mono transition-colors"
              style={{
                backgroundColor: tab === 'identity' ? 'rgba(179,136,255,0.15)' : 'rgba(255,255,255,0.03)',
                color: tab === 'identity' ? '#B388FF' : 'rgba(255,255,255,0.5)',
              }}>
              <UserCheck className="w-3 h-3" /> IDENTITY
            </button>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#FF1744]/20 rounded transition-colors">
            <X className="w-4 h-4 text-[#FF1744]" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'users' && <UsersTab token={token} />}
        {tab === 'ontology' && <OntologyTab token={token} />}
        {tab === 'connectors' && <ConnectorsTab token={token} />}
        {tab === 'backup' && <BackupTab token={token} />}
        {tab === 'identity' && <IdentityTab token={token} />}
      </div>
    </motion.div>
  );
}

// ════════════════════════════════════════════════════════════════
//  USER MANAGEMENT TAB (unchanged)
// ════════════════════════════════════════════════════════════════
function UsersTab({ token }: { token: string | null }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/auth/users', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setUsers(data.users || []);
      else setError(data.error || 'Failed to load users');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const changeRole = useCallback(async (userId: string, role: UserRole) => {
    if (!token) return;
    setSavingId(userId); setError(null);
    try {
      const res = await fetch('/api/auth/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId, role }),
      });
      const data = await res.json();
      if (res.ok) setUsers(data.users || []);
      else setError(data.error || 'Failed to update role');
    } catch { setError('Network error'); }
    finally { setSavingId(null); }
  }, [token]);

  return (
    <div className="h-full overflow-y-auto styled-scrollbar p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-bold text-white/80 tracking-wider">USER ACCOUNTS</span>
          <span className="text-[9px] font-mono text-white/40">{users.length} TOTAL</span>
        </div>
        <button onClick={load} className="flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono text-white/60 hover:text-white bg-white/5 hover:bg-white/10 transition-colors">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> REFRESH
        </button>
      </div>
      {error && <div className="mb-2 px-3 py-1.5 rounded bg-[#FF1744]/15 border border-[#FF1744]/30"><span className="text-[8px] font-mono text-[#FF1744]">{error}</span></div>}
      <div className="rounded border border-white/10 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-white/5 text-[8px] font-mono text-white/40 uppercase tracking-wider">
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                <td className="px-3 py-2 text-[10px] font-mono text-white/90 font-bold">{u.username}</td>
                <td className="px-3 py-2 text-[9px] font-mono text-white/50">{u.email}</td>
                <td className="px-3 py-2 text-[8px] font-mono text-white/40">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <select value={u.role} disabled={savingId === u.id}
                      onChange={e => changeRole(u.id, e.target.value as UserRole)}
                      className="bg-black/50 text-[9px] font-mono px-2 py-1 rounded border outline-none cursor-pointer"
                      style={{ color: ROLE_COLORS[u.role], borderColor: `${ROLE_COLORS[u.role]}40` }}>
                      {ROLES.map(r => <option key={r} value={r} style={{ color: '#fff', background: '#0a0a09' }}>{r.toUpperCase()}</option>)}
                    </select>
                    {savingId === u.id && <Loader2 className="w-3 h-3 text-white/40 animate-spin" />}
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && !loading && <tr><td colSpan={4} className="px-3 py-6 text-center text-[9px] font-mono text-white/30">No users found</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[8px] font-mono text-white/30 leading-relaxed">
        Role tiers: <span style={{ color: ROLE_COLORS.viewer }}>VIEWER</span> (read-only),{' '}
        <span style={{ color: ROLE_COLORS.analyst }}>ANALYST</span> (full investigation tools),{' '}
        <span style={{ color: ROLE_COLORS.admin }}>ADMIN</span> (user management + ontology control).
      </p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  BACKUP & RESTORE TAB
//  Download a full JSON backup of the ontology data (entities +
//  relationships) and restore it again — merge on top, or replace
//  everything. Backed by /api/admin/backup (admin only).
// ════════════════════════════════════════════════════════════════

interface BackupMeta { entities: number; relationships: number; source: 'postgres' | 'memory'; }
interface PendingRestore { fileName: string; backup: any; entities: number; relationships: number; createdAt?: string; }

function BackupTab({ token }: { token: string | null }) {
  const [meta, setMeta] = useState<BackupMeta | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadMeta = useCallback(async () => {
    if (!token) return;
    setLoadingMeta(true); setError(null);
    try {
      const res = await fetch('/api/admin/backup?meta=1', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) setMeta(data);
      else setError(data.error || 'Failed to load store stats');
    } catch { setError('Network error'); }
    finally { setLoadingMeta(false); }
  }, [token]);

  useEffect(() => { loadMeta(); }, [loadMeta]);

  const downloadBackup = useCallback(async () => {
    if (!token) return;
    setDownloading(true); setError(null); setNotice(null);
    try {
      const res = await fetch('/api/admin/backup', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Backup failed (${res.status})`);
        return;
      }
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url; a.download = `osiris-backup-${stamp}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      let count = 0;
      try { count = (JSON.parse(text)?.data?.entities || []).length; } catch { /* ignore */ }
      setNotice(`Backup downloaded · ${count} entities`);
    } catch { setError('Network error during backup'); }
    finally { setDownloading(false); }
  }, [token]);

  const onPickFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null); setNotice(null); setConfirmReplace(false);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (backup?.magic !== 'osiris-ontology-backup') {
        setError('Not an OSIRIS backup file');
        setPending(null);
        return;
      }
      setPending({
        fileName: file.name,
        backup,
        entities: backup?.data?.entities?.length || 0,
        relationships: backup?.data?.relationships?.length || 0,
        createdAt: backup?.createdAt,
      });
    } catch {
      setError('Could not read or parse the selected file');
      setPending(null);
    } finally {
      // allow re-selecting the same file
      if (fileRef.current) fileRef.current.value = '';
    }
  }, []);

  const runRestore = useCallback(async () => {
    if (!token || !pending) return;
    if (mode === 'replace' && !confirmReplace) { setConfirmReplace(true); return; }
    setRestoring(true); setError(null); setNotice(null);
    try {
      const res = await fetch('/api/admin/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ backup: pending.backup, mode }),
      });
      const data = await res.json();
      if (res.ok) {
        setNotice(`Restore complete (${data.mode}) · ${data.entities} entities, ${data.relationships} relationships${data.skipped ? `, ${data.skipped} skipped` : ''}`);
        setPending(null); setConfirmReplace(false);
        await loadMeta();
      } else {
        setError(data.error || 'Restore failed');
      }
    } catch { setError('Network error during restore'); }
    finally { setRestoring(false); }
  }, [token, pending, mode, confirmReplace, loadMeta]);

  return (
    <div className="h-full overflow-y-auto styled-scrollbar p-4 max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-bold text-white/80 tracking-wider">BACKUP &amp; RESTORE</span>
          {meta && (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ color: meta.source === 'postgres' ? '#3BA776' : '#F2A65A', background: meta.source === 'postgres' ? 'rgba(59,167,118,0.12)' : 'rgba(242,166,90,0.12)' }}>
              {meta.source === 'postgres' ? 'POSTGRES' : 'IN-MEMORY'}
            </span>
          )}
        </div>
        <button onClick={loadMeta} className="flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono text-white/60 hover:text-white bg-white/5 hover:bg-white/10 transition-colors">
          <RefreshCw className={`w-3 h-3 ${loadingMeta ? 'animate-spin' : ''}`} /> REFRESH
        </button>
      </div>

      {error && <div className="mb-2 px-3 py-1.5 rounded bg-[#FF1744]/15 border border-[#FF1744]/30 flex items-center gap-2"><AlertCircle className="w-3 h-3 text-[#FF1744]" /><span className="text-[8px] font-mono text-[#FF1744]">{error}</span></div>}
      {notice && <div className="mb-2 px-3 py-1.5 rounded bg-[#3BA776]/15 border border-[#3BA776]/30 flex items-center gap-2"><CheckCircle2 className="w-3 h-3 text-[#3BA776]" /><span className="text-[8px] font-mono text-[#3BA776]">{notice}</span></div>}

      {/* Current data */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="rounded border border-white/10 bg-white/[0.02] p-3">
          <div className="text-[8px] font-mono text-white/40 uppercase tracking-wider mb-1">Entities</div>
          <div className="text-[18px] font-mono font-bold text-white/90">{meta ? meta.entities : '—'}</div>
        </div>
        <div className="rounded border border-white/10 bg-white/[0.02] p-3">
          <div className="text-[8px] font-mono text-white/40 uppercase tracking-wider mb-1">Relationships</div>
          <div className="text-[18px] font-mono font-bold text-white/90">{meta ? meta.relationships : '—'}</div>
        </div>
      </div>

      {/* Backup */}
      <div className="rounded border border-white/10 bg-white/[0.02] p-4 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Download className="w-3.5 h-3.5 text-[#3BA776]" />
          <span className="text-[10px] font-mono font-bold text-white/80 tracking-wider">CREATE BACKUP</span>
        </div>
        <p className="text-[8px] font-mono text-white/40 leading-relaxed mb-3">
          Downloads a single JSON file with every entity and relationship in your store, checksum-protected. Keep it safe — it restores your full graph.
        </p>
        <button onClick={downloadBackup} disabled={downloading}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-[9px] font-mono font-bold transition-colors disabled:opacity-50"
          style={{ background: 'rgba(59,167,118,0.15)', color: '#3BA776', border: '1px solid rgba(59,167,118,0.4)' }}>
          {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <HardDriveDownload className="w-3 h-3" />}
          {downloading ? 'BUILDING BACKUP…' : 'DOWNLOAD BACKUP'}
        </button>
      </div>

      {/* Restore */}
      <div className="rounded border border-white/10 bg-white/[0.02] p-4">
        <div className="flex items-center gap-2 mb-2">
          <Upload className="w-3.5 h-3.5 text-[#00E5FF]" />
          <span className="text-[10px] font-mono font-bold text-white/80 tracking-wider">RESTORE FROM BACKUP</span>
        </div>
        <p className="text-[8px] font-mono text-white/40 leading-relaxed mb-3">
          Load a backup file, then choose how to apply it. <span className="text-white/60">Merge</span> adds/updates on top of current data; <span className="text-[#FF8A65]">Replace</span> wipes everything first.
        </p>

        <input ref={fileRef} type="file" accept=".json,application/json" onChange={onPickFile} className="hidden" />
        <button onClick={() => fileRef.current?.click()}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-[9px] font-mono text-white/70 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 transition-colors mb-3">
          <FileJson className="w-3 h-3" /> CHOOSE BACKUP FILE…
        </button>

        {pending && (
          <div className="rounded border border-white/10 bg-black/30 p-3">
            <div className="flex items-center gap-2 mb-2">
              <FileJson className="w-3 h-3 text-[#00E5FF]" />
              <span className="text-[9px] font-mono text-white/80 truncate">{pending.fileName}</span>
            </div>
            <div className="text-[8px] font-mono text-white/40 mb-3">
              {pending.entities} entities · {pending.relationships} relationships
              {pending.createdAt && <> · {new Date(pending.createdAt).toLocaleString()}</>}
            </div>

            <div className="flex items-center gap-1 mb-3">
              {(['merge', 'replace'] as const).map(m => (
                <button key={m} onClick={() => { setMode(m); setConfirmReplace(false); }}
                  className="px-2.5 py-1 rounded text-[8px] font-mono transition-colors"
                  style={{
                    background: mode === m ? (m === 'replace' ? 'rgba(255,138,101,0.15)' : 'rgba(0,229,255,0.15)') : 'rgba(255,255,255,0.03)',
                    color: mode === m ? (m === 'replace' ? '#FF8A65' : '#00E5FF') : 'rgba(255,255,255,0.5)',
                    border: `1px solid ${mode === m ? (m === 'replace' ? 'rgba(255,138,101,0.4)' : 'rgba(0,229,255,0.4)') : 'rgba(255,255,255,0.1)'}`,
                  }}>
                  {m.toUpperCase()}
                </button>
              ))}
            </div>

            {mode === 'replace' && confirmReplace && (
              <div className="mb-3 px-3 py-2 rounded bg-[#FF1744]/10 border border-[#FF1744]/30 flex items-start gap-2">
                <AlertTriangle className="w-3 h-3 text-[#FF1744] mt-0.5 shrink-0" />
                <span className="text-[8px] font-mono text-[#FF8A65] leading-relaxed">
                  This will permanently delete all {meta?.entities ?? 'existing'} entities and their relationships, then load the backup. Click RESTORE again to confirm.
                </span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button onClick={runRestore} disabled={restoring}
                className="flex items-center gap-2 px-3 py-1.5 rounded text-[9px] font-mono font-bold transition-colors disabled:opacity-50"
                style={
                  mode === 'replace' && confirmReplace
                    ? { background: 'rgba(255,23,68,0.2)', color: '#FF1744', border: '1px solid rgba(255,23,68,0.5)' }
                    : { background: 'rgba(0,229,255,0.15)', color: '#00E5FF', border: '1px solid rgba(0,229,255,0.4)' }
                }>
                {restoring ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                {restoring ? 'RESTORING…' : mode === 'replace' && confirmReplace ? 'CONFIRM REPLACE' : 'RESTORE'}
              </button>
              <button onClick={() => { setPending(null); setConfirmReplace(false); }} disabled={restoring}
                className="px-3 py-1.5 rounded text-[9px] font-mono text-white/50 hover:text-white bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50">
                CANCEL
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  LIVE ONTOLOGY BUILDER TAB (unchanged)
// ════════════════════════════════════════════════════════════════
function OntologyTab({ token }: { token: string | null }) {
  const [entities, setEntities] = useState<PersonalEntity[]>([]);
  const [relationships, setRelationships] = useState<PersonalRelationship[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/ontology/entities?graph=true');
      const data = await res.json();
      if (res.ok) { setEntities(data.entities || []); setRelationships(data.relationships || []); }
      else setError(data.error || 'Failed to load ontology');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleConnect = useCallback(async (sourceId: string, targetId: string) => {
    setBusy('relate'); setError(null);
    try {
      const res = await fetch('/api/ontology/entities', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ action: 'relate', sourceId, targetId, label: 'linked_to', strength: 1 }),
      });
      const data = await res.json();
      if (res.ok && data.relationship) setRelationships(prev => [...prev, data.relationship]);
      else setError(data.error || 'Failed to create link');
    } catch { setError('Network error'); }
    finally { setBusy(null); }
  }, [authHeaders]);

  const handleDeleteRelationship = useCallback(async (id: string) => {
    setRelationships(prev => prev.filter(r => r.id !== id));
    try { await fetch(`/api/ontology/entities?relId=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() }); }
    catch { /* optimistic */ }
  }, [authHeaders]);

  const handleDeleteEntity = useCallback(async (id: string) => {
    setEntities(prev => prev.filter(e => e.id !== id));
    setRelationships(prev => prev.filter(r => r.sourceId !== id && r.targetId !== id));
    try { await fetch(`/api/ontology/entities?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() }); }
    catch { /* optimistic */ }
  }, [authHeaders]);

  const handleMoveEntity = useCallback((id: string, pos: { x: number; y: number }) => {
    setEntities(prev => prev.map(e => (e.id === id ? { ...e, graphPos: pos } : e)));
  }, []);

  const handleSelectEntity = useCallback(() => {}, []);

  const addEntity = useCallback(async (type: string, label: string, description: string) => {
    setBusy('upsert'); setError(null);
    const entity = { id: generateEntityId(type), type, label, description, properties: {}, tags: [], source: 'admin' };
    try {
      const res = await fetch('/api/ontology/entities', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ action: 'upsert', entity }),
      });
      const data = await res.json();
      if (res.ok && data.entity) { setEntities(prev => [...prev, data.entity]); setShowAdd(false); }
      else setError(data.error || 'Failed to add entity');
    } catch { setError('Network error'); }
    finally { setBusy(null); }
  }, [authHeaders]);

  const runCrossReference = useCallback(async () => {
    setBusy('cross-reference'); setError(null);
    try {
      const res = await fetch('/api/ontology/entities', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ action: 'cross-reference' }),
      });
      const data = await res.json();
      if (res.ok) await load();
      else setError(data.error || 'Cross-reference failed');
    } catch { setError('Network error'); }
    finally { setBusy(null); }
  }, [authHeaders, load]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5 bg-black/20 shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#00E5FF]/10 border border-[#00E5FF]/25">
          <Radio className="w-3 h-3 text-[#00E5FF] animate-pulse" />
          <span className="text-[8px] font-mono text-[#00E5FF]">LIVE · WRITES TO RUNNING SYSTEM</span>
        </div>
        <span className="text-[9px] font-mono text-white/40">{entities.length} NODES · {relationships.length} LINKS</span>
        <div className="flex-1" />
        <button onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono"
          style={{ backgroundColor: 'rgba(212,175,55,0.15)', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.3)' }}>
          <Plus className="w-3 h-3" /> ADD ENTITY
        </button>
        <button onClick={runCrossReference} disabled={!!busy}
          className="flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono text-[#B388FF] bg-[#B388FF]/10 border border-[#B388FF]/25 disabled:opacity-40">
          {busy === 'cross-reference' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />} AUTO-LINK
        </button>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono text-white/60 hover:text-white bg-white/5 hover:bg-white/10">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> REFRESH
        </button>
      </div>
      {error && (<div className="px-4 py-1.5 bg-[#FF1744]/15 border-b border-[#FF1744]/30"><span className="text-[8px] font-mono text-[#FF1744]">{error}</span></div>)}
      <div className="flex-1 min-h-0 relative">
        <LinkEditorGraph entities={entities} relationships={relationships}
          onConnect={handleConnect} onDeleteRelationship={handleDeleteRelationship}
          onDeleteEntity={handleDeleteEntity} onMoveEntity={handleMoveEntity}
          onSelectEntity={handleSelectEntity} />
      </div>
      {showAdd && <AddEntityForm busy={busy === 'upsert'} onAdd={addEntity} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function AddEntityForm({ busy, onAdd, onClose }: { busy: boolean; onAdd: (type: string, label: string, description: string) => void; onClose: () => void }) {
  // Type picker is driven by the declarative ontology registry
  // (osiris-foundation/ontology/*.yaml via /api/ontology/types), with the
  // built-in personal-ontology types as the fallback when it's unavailable.
  const { objectTypes, loading } = useOntologyTypes();
  const typeOptions: { type: string; label: string }[] = objectTypes.length > 0
    ? objectTypes.map(o => ({ type: o.type, label: o.label }))
    : (Object.entries(PERSONAL_TYPE_LABELS) as [PersonalEntityType, string][]).map(([t, l]) => ({ type: t, label: l }));

  const [type, setType] = useState<string>('person');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');

  // Keep the selection valid once the registry resolves.
  useEffect(() => {
    if (typeOptions.length && !typeOptions.some(o => o.type === type)) setType(typeOptions[0].type);
  }, [typeOptions, type]);

  // Prefer the declarative colour from the foundation ontology registry;
  // fall back to the built-in personal-ontology palette, then OSIRIS gold.
  const colorFor = (t: string) =>
    objectTypes.find(o => o.type === t)?.color ||
    PERSONAL_TYPE_COLORS[t as PersonalEntityType] ||
    '#D4AF37';
  const labelFor = (t: string) => typeOptions.find(o => o.type === t)?.label || t;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ scale: 0.95, y: 16 }} animate={{ scale: 1, y: 0 }}
        className="w-[420px] rounded-xl border border-white/10 bg-[#0a0a09] p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-mono font-bold text-[#D4AF37] tracking-wider">ADD ONTOLOGY ENTITY</span>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-[7px] font-mono text-white/30">
            {loading ? 'LOADING REGISTRY…' : objectTypes.length > 0 ? `${objectTypes.length} TYPES · osiris-foundation/ontology` : 'BUILT-IN TYPES'}
          </span>
        </div>
        <div className="flex flex-wrap gap-1 mb-3">
          {typeOptions.map(({ type: t, label: l }) => {
            const c = colorFor(t);
            return (
              <button key={t} onClick={() => setType(t)}
                className="px-2 py-1 rounded text-[8px] font-mono transition-colors"
                style={{ backgroundColor: type === t ? `${c}20` : 'rgba(255,255,255,0.03)', color: type === t ? c : 'rgba(255,255,255,0.5)', border: `1px solid ${type === t ? `${c}40` : 'rgba(255,255,255,0.1)'}` }}>
                {l}
              </button>
            );
          })}
        </div>
        <input value={label} onChange={e => setLabel(e.target.value)} autoFocus
          placeholder={`${labelFor(type)} NAME / IDENTIFIER *`}
          className="w-full bg-black/40 text-[9px] font-mono text-white px-2 py-1.5 rounded outline-none border border-white/10 focus:border-[#D4AF37] mb-1.5" />
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
          placeholder="DESCRIPTION (OPTIONAL)"
          className="w-full bg-black/40 text-[8px] font-mono text-white/70 px-2 py-1.5 rounded outline-none border border-white/10 resize-none mb-2" />
        <button onClick={() => label.trim() && onAdd(type, label.trim(), description.trim())}
          disabled={!label.trim() || busy}
          className="w-full py-2 rounded text-[9px] font-mono font-bold transition-colors disabled:opacity-30 flex items-center justify-center gap-1.5"
          style={{ backgroundColor: 'rgba(212,175,55,0.15)', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.3)' }}>
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} ADD TO LIVE ONTOLOGY
        </button>
      </motion.div>
    </motion.div>
  );
}

// ════════════════════════════════════════════════════════════════
//  SOCIAL MEDIA CONNECTORS TAB
// ════════════════════════════════════════════════════════════════
function ConnectorsTab({ token }: { token: string | null }) {
  const [activeConnector, setActiveConnector] = useState<ConnectorTab>('twitter');
  const [expandedResults, setExpandedResults] = useState<Record<string, boolean>>({});

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Connector selector bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-white/10 bg-black/20 shrink-0 overflow-x-auto styled-scrollbar">
        {CONNECTOR_TABS.map(ct => {
          const Icon = ct.icon;
          return (
            <button key={ct.key} onClick={() => setActiveConnector(ct.key)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[8px] font-mono font-bold tracking-wider transition-all whitespace-nowrap shrink-0"
              style={{
                backgroundColor: activeConnector === ct.key ? `${ct.color}18` : 'rgba(255,255,255,0.03)',
                color: activeConnector === ct.key ? ct.color : 'rgba(255,255,255,0.45)',
                border: `1px solid ${activeConnector === ct.key ? `${ct.color}35` : 'rgba(255,255,255,0.06)'}`,
              }}>
              <Icon className="w-3 h-3" /> {ct.label}
            </button>
          );
        })}
      </div>

      {/* Selected connector panel */}
      <div className="flex-1 min-h-0 overflow-y-auto styled-scrollbar p-3">
        {activeConnector === 'twitter' && <TwitterConnector token={token} />}
        {activeConnector === 'youtube' && <YouTubeConnector token={token} />}
        {activeConnector === 'facebook' && <FacebookConnector token={token} />}
        {activeConnector === 'linkedin' && <LinkedInConnector token={token} />}
        {activeConnector === 'whatsapp' && <WhatsAppConnector token={token} />}
        {activeConnector === 'bulk-import' && <BulkImportConnector token={token} />}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  REUSABLE CONNECTOR UI COMPONENTS
// ════════════════════════════════════════════════════════════════

interface ConnectorState {
  status: 'idle' | 'loading' | 'success' | 'error';
  message: string;
  data: any;
  ontologyResult: any;
  errors: string[];
  startTime: number | null;
}

function useConnector() {
  const [state, setState] = useState<ConnectorState>({ status: 'idle', message: '', data: null, ontologyResult: null, errors: [], startTime: null });

  const execute = useCallback(async (connector: string, action: string, config: any, payload: any) => {
    setState({ status: 'loading', message: `Running ${action}...`, data: null, ontologyResult: null, errors: [], startTime: Date.now() });
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector, action, config, payload }),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        setState({
          status: 'success',
          message: result.summary || `${action} completed successfully`,
          data: result,
          ontologyResult: result.ontologyResult,
          errors: result.errors || [],
          startTime: Date.now(),
        });
      } else {
        setState(prev => ({ ...prev, status: 'error', message: result.error || `Action ${action} failed`, errors: [result.error], startTime: Date.now() }));
      }
    } catch (e: any) {
      setState(prev => ({ ...prev, status: 'error', message: e.message, errors: [e.message], startTime: Date.now() }));
    }
  }, []);

  const reset = useCallback(() => setState({ status: 'idle', message: '', data: null, ontologyResult: null, errors: [], startTime: null }), []);

  return { state, execute, reset };
}

function ConnectorResults({ state, onClear }: { state: ConnectorState; onClear: () => void }) {
  const [expanded, setExpanded] = useState(false);

  if (state.status === 'idle') return null;

  return (
    <div className="mt-3 rounded border overflow-hidden"
      style={{ borderColor: state.status === 'success' ? 'rgba(0,230,118,0.3)' : state.status === 'error' ? 'rgba(255,23,68,0.3)' : 'rgba(100,181,246,0.3)' }}>
      {/* Status header */}
      <div className="flex items-center justify-between px-3 py-1.5"
        style={{ backgroundColor: state.status === 'success' ? 'rgba(0,230,118,0.08)' : state.status === 'error' ? 'rgba(255,23,68,0.08)' : 'rgba(100,181,246,0.08)' }}>
        <div className="flex items-center gap-2">
          {state.status === 'loading' ? (
            <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
          ) : state.status === 'success' ? (
            <CheckCircle2 className="w-3 h-3 text-green-400" />
          ) : (
            <AlertCircle className="w-3 h-3 text-red-400" />
          )}
          <span className="text-[9px] font-mono"
            style={{ color: state.status === 'success' ? '#00E676' : state.status === 'error' ? '#FF1744' : '#64B5F6' }}>
            {state.message}
          </span>
          {state.startTime && state.data?.results?.length && (
            <span className="text-[7px] font-mono text-white/30">{state.data.results.length} data blocks</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {state.ontologyResult && (
            <span className="text-[8px] font-mono text-[#D4AF37]">
              {state.ontologyResult.entities?.length || 0} entities · {state.ontologyResult.relationships?.length || 0} relations
            </span>
          )}
          <button onClick={() => setExpanded(!expanded)} className="text-white/40 hover:text-white transition-colors">
            {expanded ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
          <button onClick={onClear} className="text-white/40 hover:text-red-400 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Expanded data view */}
      {expanded && state.data && (
        <div className="px-3 py-2 max-h-[400px] overflow-y-auto" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
          {state.data.results?.map((r: any, i: number) => (
            <div key={i} className="mb-2 last:mb-0">
              <div className="text-[8px] font-mono text-[#D4AF37] mb-0.5">{r.source}</div>
              <pre className="text-[7px] font-mono text-white/50 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto bg-black/40 p-2 rounded">
                {r.data?.slice(0, 3000) || '(empty)'}
                {r.data?.length > 3000 && '\n... (truncated)'}
              </pre>
            </div>
          ))}
          {state.ontologyResult && (
            <div className="mt-2 p-2 rounded"
              style={{ backgroundColor: 'rgba(212,175,55,0.08)', border: '1px solid rgba(212,175,55,0.2)' }}>
              <div className="text-[8px] font-mono text-[#D4AF37] mb-1">ONTOLOGY EXTRACTION</div>
              {state.ontologyResult.entities?.length > 0 && (
                <div className="mb-1">
                  <span className="text-[7px] font-mono text-white/50">Entities: </span>
                  <span className="text-[7px] font-mono text-green-400">{state.ontologyResult.entities.length}</span>
                </div>
              )}
              {state.ontologyResult.relationships?.length > 0 && (
                <div className="mb-1">
                  <span className="text-[7px] font-mono text-white/50">Relationships: </span>
                  <span className="text-[7px] font-mono text-cyan-400">{state.ontologyResult.relationships.length}</span>
                </div>
              )}
              {state.ontologyResult.entities?.slice(0, 10).map((e: any, i: number) => (
                <div key={i} className="text-[7px] font-mono text-white/60">
                  [{e.type.toUpperCase()}] {e.label} {e.properties?.email && `· ${e.properties.email}`}{e.properties?.phone && `· ${e.properties.phone}`}
                </div>
              ))}
              {state.ontologyResult.entities?.length > 10 && (
                <div className="text-[7px] font-mono text-white/30 mt-0.5">... +{state.ontologyResult.entities.length - 10} more entities</div>
              )}
            </div>
          )}
          {state.errors?.length > 0 && (
            <div className="mt-1">
              {state.errors.map((e, i) => (
                <div key={i} className="text-[7px] font-mono text-red-400">Error: {e}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Generic config form used by multiple connectors ──

function ConfigField({ label, value, onChange, placeholder, type = 'text', color }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; color?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[8px] font-mono text-white/50 w-20 shrink-0">{label}</span>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="flex-1 bg-black/40 text-[8px] font-mono text-white px-2 py-1 rounded outline-none border border-white/10 focus:border-[#D4AF37]"
        style={color ? { borderColor: `${color}30` } : {}} />
    </div>
  );
}

function ActionButton({ onClick, disabled, children, color = '#D4AF37' }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; color?: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex items-center gap-1 px-3 py-1.5 rounded text-[8px] font-mono font-bold transition-all disabled:opacity-30"
      style={{ backgroundColor: `${color}15`, color, border: `1px solid ${color}30` }}>
      {children}
    </button>
  );
}

// ── Generic connector form with action selector, config, and results ──

function ConnectorForm({ connector, actions, configFields, color, token }: {
  connector: ConnectorTab;
  actions: { value: string; label: string; description: string }[];
  configFields?: { key: string; label: string; placeholder?: string; type?: string }[];
  color: string;
  token: string | null;
}) {
  const [selectedAction, setSelectedAction] = useState(actions[0]?.value || '');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [payload, setPayload] = useState<Record<string, string>>({});
  const { state, execute, reset } = useConnector();

  const handleRun = () => {
    const cfg: Record<string, any> = {};
    configFields?.forEach(f => { if (config[f.key]) cfg[f.key] = config[f.key]; });

    // Build payload with text inputs plus any structured data from the form
    const pl: Record<string, any> = { ...payload, ingest: true };

    // If specific search/fetch fields exist, forward them
    if (payload.username) pl.username = payload.username;
    if (payload.query) pl.query = payload.query;
    if (payload.tweetId) pl.tweetId = payload.tweetId;
    if (payload.channelId) pl.channelId = payload.channelId;
    if (payload.videoId) pl.videoId = payload.videoId;
    if (payload.pageId) pl.pageId = payload.pageId;
    if (payload.postId) pl.postId = payload.postId;
    if (payload.groupId) pl.groupId = payload.groupId;
    if (payload.profileUrn) pl.profileUrn = payload.profileUrn;
    if (payload.companyUrn) pl.companyUrn = payload.companyUrn;
    if (payload.rawText) pl.rawText = payload.rawText;
    pl.count = parseInt(payload.count || '25', 10);

    execute(connector, selectedAction, cfg, pl);
  };

  return (
    <div>
      {/* Action selector */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 mb-3">
        {actions.map(a => (
          <button key={a.value} onClick={() => setSelectedAction(a.value)}
            className="text-left px-2.5 py-2 rounded transition-all"
            style={{
              backgroundColor: selectedAction === a.value ? `${color}12` : 'rgba(255,255,255,0.02)',
              border: `1px solid ${selectedAction === a.value ? `${color}30` : 'rgba(255,255,255,0.06)'}`,
            }}>
            <div className="text-[8px] font-mono font-bold" style={{ color: selectedAction === a.value ? color : 'rgba(255,255,255,0.7)' }}>
              {a.label}
            </div>
            <div className="text-[6px] font-mono text-white/40 mt-0.5 leading-tight">{a.description}</div>
          </button>
        ))}
      </div>

      {/* Config & payload fields */}
      <div className="space-y-1.5 mb-3">
        {configFields?.map(f => (
          <ConfigField key={f.key} label={f.label} value={config[f.key] || ''}
            onChange={v => setConfig(prev => ({ ...prev, [f.key]: v }))}
            placeholder={f.placeholder} type={f.type || 'text'} color={color} />
        ))}
        <PayloadInput connector={connector} selectedAction={selectedAction} payload={payload} setPayload={setPayload} color={color} />
      </div>

      {/* Run button */}
      <div className="flex items-center gap-2 mb-3">
        <ActionButton onClick={handleRun} disabled={state.status === 'loading'} color={color}>
          {state.status === 'loading' ? <><Loader2 className="w-3 h-3 animate-spin" /> RUNNING...</> : <><Zap className="w-3 h-3" /> EXECUTE & INGEST</>}
        </ActionButton>
        {state.status !== 'idle' && (
          <button onClick={reset} className="text-[7px] font-mono text-white/40 hover:text-white transition-colors">CLEAR</button>
        )}
      </div>

      {/* Results */}
      <ConnectorResults state={state} onClear={reset} />
    </div>
  );
}

// ── Dynamic payload inputs based on connector + action ──

function PayloadInput({ connector, selectedAction, payload, setPayload, color }: {
  connector: ConnectorTab; selectedAction: string; payload: Record<string, string>;
  setPayload: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  color: string;
}) {
  const fields: { key: string; label: string; placeholder: string }[] = [];

  // Common payload fields
  switch (connector) {
    case 'twitter':
      if (['fetch-profile', 'fetch-tweets', 'fetch-thread', 'fetch-followers', 'fetch-following', 'ingest-all'].includes(selectedAction)) {
        fields.push({ key: 'username', label: 'Username', placeholder: '@username (no @)' });
      }
      if (selectedAction === 'fetch-thread') {
        fields.push({ key: 'tweetId', label: 'Tweet ID', placeholder: '1234567890' });
      }
      if (selectedAction === 'search') {
        fields.push({ key: 'query', label: 'Search Query', placeholder: 'keyword search' });
      }
      fields.push({ key: 'count', label: 'Count', placeholder: '25 (max 500)' });
      break;

    case 'youtube':
      if (['fetch-channel', 'ingest-all'].includes(selectedAction)) {
        fields.push({ key: 'channelId', label: 'Channel ID', placeholder: 'UC...' });
      }
      if (['fetch-video', 'fetch-comments'].includes(selectedAction)) {
        fields.push({ key: 'videoId', label: 'Video ID', placeholder: 'dQw4w9WgXcQ' });
      }
      if (selectedAction === 'search') {
        fields.push({ key: 'query', label: 'Search Query', placeholder: 'keyword search' });
      }
      break;

    case 'facebook':
      if (['fetch-page', 'fetch-posts'].includes(selectedAction)) {
        fields.push({ key: 'pageId', label: 'Page ID', placeholder: 'Facebook page ID' });
      }
      if (['fetch-comments'].includes(selectedAction)) {
        fields.push({ key: 'postId', label: 'Post ID', placeholder: 'Facebook post ID' });
      }
      if (selectedAction === 'fetch-groups') {
        fields.push({ key: 'groupId', label: 'Group ID', placeholder: 'Facebook group ID' });
      }
      break;

    case 'linkedin':
      if (['fetch-profile', 'fetch-posts'].includes(selectedAction)) {
        fields.push({ key: 'profileUrn', label: 'Profile URN', placeholder: 'urn:li:person:abc' });
      }
      if (['fetch-comments'].includes(selectedAction)) {
        fields.push({ key: 'postUrn', label: 'Post URN', placeholder: 'urn:li:activity:xyz' });
      }
      if (['fetch-company', 'fetch-posts'].includes(selectedAction)) {
        fields.push({ key: 'companyUrn', label: 'Company URN', placeholder: 'urn:li:company:acme' });
      }
      break;

    case 'whatsapp':
      if (selectedAction === 'ingest-chat' || selectedAction === 'ingest-all') {
        fields.push({ key: 'rawText', label: 'Raw Export', placeholder: 'Paste WhatsApp export .txt content here...' });
      }
      break;
  }

  if (fields.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {fields.map(f => (
        f.key === 'rawText' ? (
          <div key={f.key}>
            <span className="text-[8px] font-mono text-white/50 block mb-1">{f.label}</span>
            <textarea value={payload[f.key] || ''} onChange={e => setPayload(prev => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={f.placeholder} rows={5}
              className="w-full bg-black/40 text-[8px] font-mono text-white px-2 py-1.5 rounded outline-none border border-white/10 focus:border-[#D4AF37] resize-none" />
            <div className="text-[7px] font-mono text-white/30 mt-0.5">Paste the raw .txt export from WhatsApp. Supports standard [date, time] Sender: message format.</div>
          </div>
        ) : (
          <ConfigField key={f.key} label={f.label} value={payload[f.key] || ''}
            onChange={v => setPayload(prev => ({ ...prev, [f.key]: v }))}
            placeholder={f.placeholder} color={color} />
        )
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  FILE UPLOAD SECTION — for each connector
// ════════════════════════════════════════════════════════════════

function FileUploadSection({ connector, label, color, token }: {
  connector: string; label: string; color: string; token: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [parsedData, setParsedData] = useState<any>(null);
  const [entryCount, setEntryCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { state, execute, reset } = useConnector();

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        setParsedData(data);
        // Count entries — count top-level array or object keys
        if (Array.isArray(data)) setEntryCount(data.length);
        else if (typeof data === 'object') setEntryCount(Object.keys(data).length);
        else setEntryCount(1);
      } catch {
        setError('Invalid JSON file. Please select a valid .json file.');
        setParsedData(null);
        setEntryCount(0);
      }
    };
    reader.readAsText(file);
    // Allow re-selecting same file
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const handleUpload = useCallback(() => {
    if (!parsedData) return;
    execute(connector, 'upload-file', {}, {
      fileData: parsedData,
      fileName: fileName || `${connector}_data.json`,
      ingest: true,
    });
  }, [parsedData, fileName, connector, execute]);

  return (
    <div className="mt-6 pt-4 border-t border-white/10">
      <div className="flex items-center gap-2 mb-2">
        <Upload className="w-3.5 h-3.5" style={{ color }} />
        <span className="text-[9px] font-mono font-bold tracking-wider" style={{ color }}>
          UPLOAD SYNTHETIC DATA
        </span>
        <span className="text-[7px] font-mono text-white/30">JSON file → {label}</span>
      </div>
      <p className="text-[7px] font-mono text-white/40 mb-3 leading-relaxed">
        Upload a pre-prepared JSON file containing {label.toLowerCase()} data (profiles, posts, comments, etc.).
        The data will be parsed and sent to the AI ontology ingestion pipeline.
      </p>

      <input ref={fileRef} type="file" accept=".json,application/json" onChange={handleFile} className="hidden" />

      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[8px] font-mono transition-colors"
          style={{ backgroundColor: `${color}12`, color, border: `1px solid ${color}30` }}>
          <FileJson className="w-3 h-3" /> CHOOSE FILE…
        </button>
        {fileName && (
          <span className="text-[7px] font-mono text-white/50 truncate max-w-[300px]">{fileName}</span>
        )}
        {fileName && parsedData && (
          <span className="text-[7px] font-mono text-white/40">
            · {entryCount} entries
          </span>
        )}
      </div>

      {error && (
        <div className="mb-2 px-3 py-1.5 rounded bg-[#FF1744]/15 border border-[#FF1744]/30">
          <span className="text-[7px] font-mono text-[#FF1744]">{error}</span>
        </div>
      )}

      {parsedData && (
        <div className="flex items-center gap-2 mb-3">
          <button onClick={handleUpload} disabled={state.status === 'loading'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[8px] font-mono font-bold transition-colors disabled:opacity-30"
            style={{ backgroundColor: `${color}18`, color, border: `1px solid ${color}40` }}>
            {state.status === 'loading' ? <><Loader2 className="w-3 h-3 animate-spin" /> UPLOADING & INGESTING...</> : <><Upload className="w-3 h-3" /> UPLOAD & INGEST</>}
          </button>
          <button onClick={() => { setParsedData(null); setFileName(''); setEntryCount(0); reset(); }}
            className="text-[7px] font-mono text-white/40 hover:text-white transition-colors">
            CLEAR
          </button>
        </div>
      )}

      <ConnectorResults state={state} onClear={reset} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  INDIVIDUAL CONNECTOR IMPLEMENTATIONS
// ════════════════════════════════════════════════════════════════

function TwitterConnector({ token }: { token: string | null }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Twitter className="w-4 h-4 text-[#1DA1F2]" />
        <span className="text-[10px] font-mono font-bold text-white/80 tracking-wider">X / TWITTER CONNECTOR</span>
        <span className="text-[7px] font-mono text-white/30">OAuth 1.0a · API v2 · Bearer Token</span>
      </div>
      <div className="text-[7px] font-mono text-white/40 mb-3 leading-relaxed">
        Fetches profiles, tweets, threads, followers, and following lists with full metadata (timestamps, device hints, geotags, handles, hashtags, mentions, media URLs). All data is normalised and sent to the AI ontology ingestion pipeline for automated entity+relationship extraction.
      </div>
      <ConnectorForm
        connector="twitter"
        actions={CONNECTOR_ACTIONS.twitter}
        color="#1DA1F2"
        token={token}
        configFields={[
          { key: 'bearerToken', label: 'Bearer Token', placeholder: 'AAAAAAAAAAAA...', type: 'password' },
        ]}
      />
      <FileUploadSection connector="twitter" label="Twitter" color="#1DA1F2" token={token} />
    </div>
  );
}

function YouTubeConnector({ token }: { token: string | null }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Video className="w-4 h-4 text-[#FF0000]" />
        <span className="text-[10px] font-mono font-bold text-white/80 tracking-wider">YOUTUBE CONNECTOR</span>
        <span className="text-[7px] font-mono text-white/30">Data API v3 · API Key</span>
      </div>
      <div className="text-[7px] font-mono text-white/40 mb-3 leading-relaxed">
        Fetches channel metadata, video lists, comments, and replies. Captures full metadata — published dates, view/like/comment stats, duration, tags, category, language, recording locations, and reaction counts. All data feeds into the ontology engine for relationship extraction.
      </div>
      <ConnectorForm
        connector="youtube"
        actions={CONNECTOR_ACTIONS.youtube}
        color="#FF0000"
        token={token}
        configFields={[
          { key: 'apiKey', label: 'API Key', placeholder: 'AIzaSy...', type: 'password' },
        ]}
      />
      <FileUploadSection connector="youtube" label="YouTube" color="#FF0000" token={token} />
    </div>
  );
}

function FacebookConnector({ token }: { token: string | null }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Share2 className="w-4 h-4 text-[#1877F2]" />
        <span className="text-[10px] font-mono font-bold text-white/80 tracking-wider">FACEBOOK CONNECTOR</span>
        <span className="text-[7px] font-mono text-white/30">Graph API v18 · Access Token</span>
      </div>
      <div className="text-[7px] font-mono text-white/40 mb-3 leading-relaxed">
        Fetches page info, posts with reactions/shares, threaded comments with reaction breakdowns, and group membership data. Captures full metadata — creator IDs, timestamps, post types, link attachments, media, location, and reaction-type distributions. All ingested into ontology.
      </div>
      <ConnectorForm
        connector="facebook"
        actions={CONNECTOR_ACTIONS.facebook}
        color="#1877F2"
        token={token}
        configFields={[
          { key: 'accessToken', label: 'Access Token', placeholder: 'EAAC...', type: 'password' },
        ]}
      />
      <FileUploadSection connector="facebook" label="Facebook" color="#1877F2" token={token} />
    </div>
  );
}

function LinkedInConnector({ token }: { token: string | null }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Briefcase className="w-4 h-4 text-[#0A66C2]" />
        <span className="text-[10px] font-mono font-bold text-white/80 tracking-wider">LINKEDIN CONNECTOR</span>
        <span className="text-[7px] font-mono text-white/30">REST API · OAuth 2.0</span>
      </div>
      <div className="text-[7px] font-mono text-white/40 mb-3 leading-relaxed">
        Fetches profiles with full career history (positions, education, skills), company pages with employee data, and post/comment engagement. Captures metadata like employment dates, industry, location hierarchy, and connection counts. All feeds into ontology for organisational analysis.
      </div>
      <ConnectorForm
        connector="linkedin"
        actions={CONNECTOR_ACTIONS.linkedin}
        color="#0A66C2"
        token={token}
        configFields={[
          { key: 'accessToken', label: 'Access Token', placeholder: 'AQV...', type: 'password' },
        ]}
      />
      <FileUploadSection connector="linkedin" label="LinkedIn" color="#0A66C2" token={token} />
    </div>
  );
}

function WhatsAppConnector({ token }: { token: string | null }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare className="w-4 h-4 text-[#25D366]" />
        <span className="text-[10px] font-mono font-bold text-white/80 tracking-wider">WHATSAPP CONNECTOR</span>
        <span className="text-[7px] font-mono text-white/30">Chat Export Parser · No API Key Needed</span>
      </div>
      <div className="text-[7px] font-mono text-white/40 mb-3 leading-relaxed">
        Parses standard WhatsApp .txt chat exports and media metadata logs. Automatically detects participants, message counts, media items, group vs. 1:1 chat, and date ranges. Extracted communications data is fed to the ontology engine to build person-to-person relationship graphs.
      </div>
      <ConnectorForm
        connector="whatsapp"
        actions={CONNECTOR_ACTIONS.whatsapp}
        color="#25D366"
        token={token}
      />
      <FileUploadSection connector="whatsapp" label="WhatsApp" color="#25D366" token={token} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  BULK IMPORTER
// ════════════════════════════════════════════════════════════════

function BulkImportConnector({ token }: { token: string | null }) {
  const [importType, setImportType] = useState<BulkImportType>('person-ids');
  const [csvText, setCsvText] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [parsedRows, setParsedRows] = useState<any[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const { state, execute, reset } = useConnector();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [expandedPreview, setExpandedPreview] = useState(true);

  const template = BULK_TEMPLATES[importType];

  const parseCSV = useCallback((text: string) => {
    setParseError(null);
    const lines = text.trim().split('\n').filter(l => l.trim());
    if (lines.length < 1) { setParsedRows([]); return; }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));
    const rows = lines.slice(1).map((line, i) => {
      const vals = line.split(',').map(v => v.trim());
      const row: any = {};
      headers.forEach((h, idx) => { if (idx < vals.length) row[h] = vals[idx]; });
      return row;
    }).filter(r => Object.values(r).some(v => v));
    setParsedRows(rows);
    if (rows.length === 0) setParseError('No valid data rows found. Check CSV format.');
  }, []);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvText(text);
      parseCSV(text);
    };
    reader.readAsText(file);
  }, [parseCSV]);

  const handleImport = () => {
    if (parsedRows.length === 0) return;
    execute('bulk-import', importType, {}, {
      rows: parsedRows,
      sourceName: sourceName || `bulk_${importType}_${Date.now()}`,
      ingest: true,
    });
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Database className="w-4 h-4 text-[#D4AF37]" />
        <span className="text-[10px] font-mono font-bold text-white/80 tracking-wider">BULK IMPORTER</span>
        <span className="text-[7px] font-mono text-white/30">CSV Parser · Person IDs / Phone Contacts / Rosters</span>
      </div>

      {/* Import type selector */}
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        {(Object.entries(BULK_TEMPLATES) as [BulkImportType, typeof template][]).map(([key, tmpl]) => (
          <button key={key} onClick={() => { setImportType(key); setParsedRows([]); setCsvText(''); setParseError(null); }}
            className="text-left px-2.5 py-2 rounded transition-all"
            style={{
              backgroundColor: importType === key ? 'rgba(212,175,55,0.12)' : 'rgba(255,255,255,0.02)',
              border: `1px solid ${importType === key ? 'rgba(212,175,55,0.3)' : 'rgba(255,255,255,0.06)'}`,
            }}>
            <div className="text-[8px] font-mono font-bold" style={{ color: importType === key ? '#D4AF37' : 'rgba(255,255,255,0.7)' }}>
              {key === 'person-ids' ? 'PERSON IDS' : key === 'phone-contacts' ? 'PHONE CONTACTS' : 'PERSONS & JOBS'}
            </div>
            <div className="text-[6px] font-mono text-white/40 mt-0.5 leading-tight">{tmpl.headers.length} fields</div>
          </button>
        ))}
      </div>

      {/* Source name */}
      <div className="mb-3">
        <ConfigField label="Source Name" value={sourceName}
          onChange={setSourceName} placeholder="e.g., target_company_employees" color="#D4AF37" />
      </div>

      {/* CSV input */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[8px] font-mono text-white/50">CSV DATA — <span className="text-[#D4AF37]">{importType === 'person-ids' ? 'person_name, id_type, id_number, country, dob, nationality, notes' :
            importType === 'phone-contacts' ? 'contact_name, phone_number, email, address, city, country, organization, notes' :
            'person_name, job_title, company, department, email, phone, linkedin, location, reports_to, notes'}</span></span>
          <div className="flex items-center gap-2">
            <button onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 px-2 py-1 rounded text-[7px] font-mono text-white/50 hover:text-white bg-white/5 hover:bg-white/10 transition-colors">
              <Upload className="w-3 h-3" /> UPLOAD CSV
            </button>
            <button onClick={() => {
              navigator.clipboard.writeText(template.headers.join(',') + '\n' + template.sample);
            }}
              className="flex items-center gap-1 px-2 py-1 rounded text-[7px] font-mono text-white/50 hover:text-white bg-white/5 hover:bg-white/10 transition-colors">
              <Copy className="w-3 h-3" /> COPY SAMPLE
            </button>
          </div>
        </div>
        <input ref={fileInputRef} type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
        <textarea value={csvText} onChange={e => { setCsvText(e.target.value); parseCSV(e.target.value); }}
          placeholder={`Paste CSV data or upload a file.\n\nHeaders:\n${template.headers.join(', ')}\n\nExample:\n${template.sample}`}
          rows={6}
          className="w-full bg-black/40 text-[8px] font-mono text-white px-2 py-1.5 rounded outline-none border border-white/10 focus:border-[#D4AF37] resize-none" />
        {parseError && <div className="text-[7px] font-mono text-red-400 mt-0.5">{parseError}</div>}
      </div>

      {/* Parsed preview */}
      {parsedRows.length > 0 && (
        <div className="mb-3">
          <button onClick={() => setExpandedPreview(!expandedPreview)}
            className="flex items-center gap-1 text-[8px] font-mono text-[#D4AF37] mb-1">
            {expandedPreview ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {parsedRows.length} ROWS PARSED
          </button>
          {expandedPreview && (
            <div className="max-h-[200px] overflow-y-auto rounded border border-white/10" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-white/5 text-[7px] font-mono text-white/40 uppercase tracking-wider sticky top-0">
                    <th className="px-2 py-1">#</th>
                    {Object.keys(parsedRows[0]).slice(0, 5).map(h => (
                      <th key={h} className="px-2 py-1">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.slice(0, 50).map((row, i) => (
                    <tr key={i} className="border-t border-white/5 text-[7px] font-mono">
                      <td className="px-2 py-1 text-white/30">{i + 1}</td>
                      {Object.keys(parsedRows[0]).slice(0, 5).map(h => (
                        <td key={h} className="px-2 py-1 text-white/60 max-w-[200px] truncate">{row[h] || '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsedRows.length > 50 && (
                <div className="text-[7px] font-mono text-white/30 text-center py-1">... +{parsedRows.length - 50} more rows</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Import button */}
      <div className="flex items-center gap-2 mb-3">
        <ActionButton onClick={handleImport} disabled={parsedRows.length === 0 || state.status === 'loading'} color="#D4AF37">
          {state.status === 'loading' ? <><Loader2 className="w-3 h-3 animate-spin" /> IMPORTING {parsedRows.length} ROWS...</> : <><Database className="w-3 h-3" /> IMPORT {parsedRows.length > 0 ? `${parsedRows.length} ROWS` : ''} → ONTOLOGY</>}
        </ActionButton>
        {state.status !== 'idle' && (
          <button onClick={reset} className="text-[7px] font-mono text-white/40 hover:text-white transition-colors">CLEAR</button>
        )}
      </div>

      {/* Results */}
      <ConnectorResults state={state} onClear={reset} />
      <FileUploadSection connector="bulk-import" label="Bulk Import" color="#D4AF37" token={token} />
    </div>
  );
}
