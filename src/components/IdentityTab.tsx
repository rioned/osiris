'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Identity Resolution Review Queue
 *
 *  Admin-only tab: lists all same_as merge candidates with
 *  signal breakdown, confidence scores, and MERGE/DISMISS actions.
 *
 *  Backed by GET/POST/DELETE /api/admin/merge
 * ═══════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  UserCheck, RefreshCw, Loader2, AlertCircle, CheckCircle2,
  User, AtSign, Phone, CreditCard, Globe, MapPin, Wifi, Calendar,
  Car, Image, Activity, Zap,
} from 'lucide-react';

// ── Props ──
interface Props {
  token: string | null;
}

// ── Signal labels and colours ──
const SIGNAL_META: Record<string, { label: string; color: string; icon: any }> = {
  same_phone:           { label: 'Same phone number',     color: '#00E5FF', icon: Phone },
  same_email:           { label: 'Same email address',    color: '#39FF14', icon: AtSign },
  fuzzy_name_match:     { label: 'Fuzzy name match',      color: '#B388FF', icon: User },
  alias_overlap:        { label: 'Shared alias',          color: '#FFD700', icon: UserCheck },
  profile_person_link:  { label: 'Profile ↔ Person',      color: '#FF9500', icon: Globe },
  photo_similarity:     { label: 'Photo similarity',       color: '#E040FB', icon: Image },
  behavioural_fingerprint: { label: 'Behavioural pattern', color: '#FF6D00', icon: Activity },
  auto_detected:        { label: 'Auto-detected',          color: '#888888', icon: Zap },
};

const TYPE_ICONS: Record<string, any> = {
  person: User, phone_number: Phone, social_profile: AtSign,
  personal_id: CreditCard, vehicle: Car, place: MapPin,
  mac_address: Wifi, wifi_network: Globe, event: Calendar,
  image_media: Image, organization: User, email_address: AtSign,
};

const TYPE_COLORS: Record<string, string> = {
  person: '#B388FF', phone_number: '#00E5FF', social_profile: '#FF6D00',
  personal_id: '#D4AF37', vehicle: '#FF3D3D', place: '#76FF03',
  mac_address: '#39FF14', wifi_network: '#00BCD4', event: '#FF9500',
  image_media: '#E040FB', organization: '#FF6D00', email_address: '#00E5FF',
};

export default function IdentityTab({ token }: Props) {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmMerge, setConfirmMerge] = useState<string | null>(null);

  const loadCandidates = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/admin/merge', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) setCandidates(data.candidates || []);
      else setError(data.error || 'Failed to load');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { loadCandidates(); }, [loadCandidates]);

  const handleMerge = useCallback(async (primaryId: string, duplicateId: string) => {
    if (!token) return;
    setMerging(duplicateId); setError(null); setNotice(null);
    try {
      const res = await fetch('/api/admin/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ primaryId, duplicateId }),
      });
      const data = await res.json();
      if (res.ok) {
        setNotice(`Merged: ${duplicateId.slice(0, 20)} → ${primaryId.slice(0, 20)}`);
        setCandidates(c => c.filter(cand =>
          cand.primaryEntity?.id !== duplicateId && cand.duplicateEntity?.id !== duplicateId
        ));
        setConfirmMerge(null);
      } else setError(data.error || 'Merge failed');
    } catch { setError('Network error'); }
    finally { setMerging(null); }
  }, [token]);

  const handleDismiss = useCallback(async (relId: string) => {
    if (!token) return;
    setError(null);
    try {
      const res = await fetch('/api/admin/merge', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ relationshipId: relId }),
      });
      if (res.ok) {
        setCandidates(c => c.filter(cand => cand.sameAsRelationship?.id !== relId));
        setNotice('Candidate dismissed');
      } else { const d = await res.json(); setError(d.error || 'Dismiss failed'); }
    } catch { setError('Network error'); }
  }, [token]);

  return (
    <div className="h-full overflow-y-auto styled-scrollbar p-4">
      {/* HEADER */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <UserCheck className="w-3.5 h-3.5 text-[#B388FF]" />
          <span className="text-[11px] font-mono font-bold text-white/80 tracking-wider">
            IDENTITY RESOLUTION
          </span>
          <span className="text-[9px] font-mono text-white/40">
            {loading ? 'LOADING...' : `${candidates.length} CANDIDATES`}
          </span>
        </div>
        <button onClick={loadCandidates} disabled={loading}
          className="flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono transition-colors"
          style={{ color: 'rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.05)' }}>
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          REFRESH
        </button>
      </div>

      {/* STATUS MESSAGES */}
      {error && (
        <div className="mb-2 px-3 py-1.5 rounded flex items-center gap-2"
          style={{ background: 'rgba(255,23,68,0.15)', border: '1px solid rgba(255,23,68,0.3)' }}>
          <AlertCircle className="w-3 h-3 shrink-0 text-[#FF1744]" />
          <span className="text-[8px] font-mono text-[#FF1744]">{error}</span>
        </div>
      )}
      {notice && (
        <div className="mb-2 px-3 py-1.5 rounded flex items-center gap-2"
          style={{ background: 'rgba(59,167,118,0.15)', border: '1px solid rgba(59,167,118,0.3)' }}>
          <CheckCircle2 className="w-3 h-3 shrink-0 text-[#3BA776]" />
          <span className="text-[8px] font-mono text-[#3BA776]">{notice}</span>
        </div>
      )}

      {/* EMPTY STATE */}
      {candidates.length === 0 && !loading && (
        <div className="rounded border border-dashed p-8 text-center" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
          <UserCheck className="w-6 h-6 mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.2)' }} />
          <p className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.3)' }}>
            No merge candidates. Import data from connectors or run cross-reference to find identity matches.
          </p>
        </div>
      )}

      {/* CANDIDATE LIST */}
      {candidates.length > 0 && (
        <div className="space-y-2">
          {candidates.map((cand, idx) => {
            const primary = cand.primaryEntity || {};
            const dupe = cand.duplicateEntity || {};
            const PrimaryIcon = TYPE_ICONS[primary.type] || User;
            const DupeIcon = TYPE_ICONS[dupe.type] || User;
            const primaryColor = TYPE_COLORS[primary.type] || '#888';
            const dupeColor = TYPE_COLORS[dupe.type] || '#888';
            const signals: string[] = cand.sharedSignals || ['auto_detected'];
            const confidence = typeof cand.aggregateConfidence === 'number'
              ? cand.aggregateConfidence : (cand.sameAsRelationship?.strength || 0.5);

            return (
              <motion.div
                key={cand.sameAsRelationship?.id || idx}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.03 }}
                className="rounded border p-3"
                style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.02)' }}
              >
                <div className="flex items-start justify-between gap-3">
                  {/* ENTITY PAIR */}
                  <div className="flex-1 min-w-0">
                    {/* PRIMARY */}
                    <div className="flex items-center gap-2 mb-1">
                      <PrimaryIcon className="w-3 h-3 shrink-0" style={{ color: primaryColor }} />
                      <span className="text-[10px] font-mono font-bold truncate"
                        style={{ color: 'rgba(255,255,255,0.9)' }}>
                        {primary.label || primary.id || 'Unknown'}
                      </span>
                      <span className="text-[7px] font-mono px-1 py-0.5 rounded shrink-0"
                        style={{ background: `${primaryColor}20`, color: primaryColor }}>
                        {primary.type?.toUpperCase() || '?'}
                      </span>
                    </div>
                    {/* CONNECTOR LINE */}
                    <div className="flex items-center gap-2 ml-1.5 mb-1">
                      <div className="w-px h-3" style={{ background: 'rgba(255,255,255,0.15)' }} />
                      <div className="flex items-center gap-1">
                        <Zap className="w-2.5 h-2.5 shrink-0" style={{ color: '#B388FF' }} />
                        <span className="text-[8px] font-mono" style={{ color: '#B388FF' }}>
                          {primary.type === 'person' ? 'maps to' : 'belongs to'}
                        </span>
                      </div>
                    </div>
                    {/* DUPLICATE */}
                    <div className="flex items-center gap-2 ml-3.5">
                      <DupeIcon className="w-3 h-3 shrink-0" style={{ color: dupeColor }} />
                      <span className="text-[10px] font-mono truncate"
                        style={{ color: 'rgba(255,255,255,0.7)' }}>
                        {dupe.label || dupe.id || 'Unknown'}
                      </span>
                      <span className="text-[7px] font-mono px-1 py-0.5 rounded shrink-0"
                        style={{ background: `${dupeColor}20`, color: dupeColor }}>
                        {dupe.type?.toUpperCase() || '?'}
                      </span>
                    </div>
                    {/* SIGNALS */}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {signals.map((sig: string) => {
                        const meta = SIGNAL_META[sig] || { label: sig, color: '#888', icon: Activity };
                        const SigIcon = meta.icon;
                        return (
                          <span key={sig}
                            className="inline-flex items-center gap-1 text-[7px] font-mono px-1 py-0.5 rounded"
                            style={{ background: `${meta.color}18`, color: meta.color }}>
                            <SigIcon className="w-2 h-2" />
                            {meta.label}
                          </span>
                        );
                      })}
                      {/* CONFIDENCE BADGE */}
                      <span className="inline-flex items-center gap-1 text-[7px] font-mono px-1 py-0.5 rounded"
                        style={{
                          background: confidence >= 0.95
                            ? 'rgba(57,255,20,0.15)'
                            : confidence >= 0.8
                              ? 'rgba(179,136,255,0.15)'
                              : 'rgba(255,149,0,0.15)',
                          color: confidence >= 0.95
                            ? '#39FF14'
                            : confidence >= 0.8
                              ? '#B388FF'
                              : '#FF9500',
                        }}>
                        <Zap className="w-2 h-2" />
                        {(confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  {/* ACTIONS */}
                  <div className="flex items-center gap-1 shrink-0">
                    {confirmMerge === dupe.id ? (
                      <>
                        <button onClick={() => handleMerge(primary.id, dupe.id)}
                          disabled={merging === dupe.id}
                          className="px-2 py-1 rounded text-[8px] font-mono font-bold transition-colors disabled:opacity-50"
                          style={{
                            background: 'rgba(255,23,68,0.2)',
                            border: '1px solid rgba(255,23,68,0.4)',
                            color: '#FF1744',
                          }}>
                          {merging === dupe.id
                            ? <><Loader2 className="w-2.5 h-2.5 animate-spin inline" /> MERGING</>
                            : 'CONFIRM MERGE'}
                        </button>
                        <button onClick={() => setConfirmMerge(null)}
                          className="px-2 py-1 rounded text-[8px] font-mono transition-colors"
                          style={{ color: 'rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.05)' }}>
                          CANCEL
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setConfirmMerge(dupe.id)}
                          className="px-2 py-1 rounded text-[8px] font-mono font-bold transition-colors"
                          style={{
                            background: 'rgba(179,136,255,0.15)',
                            border: '1px solid rgba(179,136,255,0.3)',
                            color: '#B388FF',
                          }}>
                          <UserCheck className="w-2.5 h-2.5 inline mr-0.5" />
                          MERGE
                        </button>
                        <button onClick={() => handleDismiss(cand.sameAsRelationship?.id)}
                          className="px-2 py-1 rounded text-[8px] font-mono transition-colors"
                          style={{ color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.05)' }}>
                          DISMISS
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* FOOTER */}
      <p className="mt-4 text-[8px] font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.15)' }}>
        Cross-platform identity resolution fuses the same real person across X, Facebook, LinkedIn, WhatsApp,
        phone contacts, and national IDs into a single ontology node.
        Merge confirmed candidates to consolidate into one entity.
        Dismiss false positives to suppress future matches.
        Photo similarity and behavioural fingerprint signals will be added in a future update.
      </p>
    </div>
  );
}
