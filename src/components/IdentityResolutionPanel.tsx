'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Identity Resolution Review Queue
 *
 *  Right-hand sidebar that surfaces cross-platform identity matches
 *  (see lib/identity-resolution.ts) for MANUAL review: every proposed
 *  unification of two nodes carries a confidence score and a signal
 *  breakdown, and is only applied when an analyst clicks MERGE. Folded
 *  identities are listed below with a SPLIT control to reverse a merge.
 *
 *  Pure presentation: all store mutation happens in the parent via the
 *  onMerge / onReject / onSplit callbacks, mirroring how the analytics
 *  and chat sidebars are wired into PersonalGraphPanel.
 * ═══════════════════════════════════════════════════════════════
 */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { X, ScanFace, UserCheck, UserX, Split, GitMerge, ShieldCheck, Network } from 'lucide-react';
import { PersonalStore, PERSONAL_TYPE_COLORS, PERSONAL_TYPE_LABELS } from '@/lib/personal-ontology';
import {
  getReviewQueue, listMergedEntities, type IdentityCandidate,
} from '@/lib/identity-resolution';

const IDENTITY_COLOR = '#4DA3FF';

interface Props {
  store: PersonalStore;
  onMerge: (primaryId: string, secondaryId: string, candidate: IdentityCandidate) => void;
  onReject: (candidate: IdentityCandidate) => void;
  onSplit: (primaryId: string, recordId: string) => void;
  onSelectEntity: (id: string) => void;
  onClose: () => void;
}

// Confidence → colour band, so an analyst can triage at a glance.
function confColor(score: number): string {
  if (score >= 0.85) return '#06D6A0';
  if (score >= 0.65) return '#FFD166';
  return '#FF9F45';
}

function TypeBadge({ type }: { type: keyof typeof PERSONAL_TYPE_COLORS }) {
  const color = PERSONAL_TYPE_COLORS[type] || '#888';
  return (
    <span
      className="text-[7px] font-mono px-1 py-0.5 rounded whitespace-nowrap"
      style={{ backgroundColor: `${color}20`, color, border: `1px solid ${color}40` }}
    >
      {(PERSONAL_TYPE_LABELS[type] || type).toUpperCase()}
    </span>
  );
}

export default function IdentityResolutionPanel({
  store, onMerge, onReject, onSplit, onSelectEntity, onClose,
}: Props) {
  // Recompute on every store change — counts are small (client-side workspace).
  const queue = useMemo(() => getReviewQueue(store), [store]);
  const merged = useMemo(() => listMergedEntities(store), [store]);

  return (
    <motion.div
      initial={{ x: 400, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 400, opacity: 0 }}
      transition={{ type: 'tween', duration: 0.25 }}
      className="absolute right-0 top-0 bottom-0 z-50 w-[380px] border-l border-white/10 bg-black/95 backdrop-blur-md flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <ScanFace className="w-3.5 h-3.5" style={{ color: IDENTITY_COLOR }} />
          <span className="text-[10px] font-mono font-bold tracking-wider" style={{ color: IDENTITY_COLOR }}>
            IDENTITY RESOLUTION
          </span>
        </div>
        <button onClick={onClose} className="text-white/40 hover:text-white p-1">
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto styled-scrollbar p-3 space-y-4">
        <p className="text-[8px] font-mono text-white/40 leading-relaxed">
          Unify the same real person across every source into one node — fusing handles, numbers,
          IDs and photos via fuzzy name, shared phone/email, photo and behavioural signals. Review
          each match below; nothing is merged automatically.
        </p>

        {/* ── REVIEW QUEUE ── */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <GitMerge className="w-3 h-3" style={{ color: IDENTITY_COLOR }} />
            <span className="text-[8px] font-mono font-bold tracking-wider text-white/60">
              REVIEW QUEUE ({queue.length})
            </span>
          </div>

          {queue.length === 0 ? (
            <div className="text-center py-6">
              <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-white/15" />
              <p className="text-[9px] font-mono text-white/30">No identity matches pending</p>
              <p className="text-[7px] font-mono text-white/20 mt-1">
                Add people, profiles, numbers or IDs that share signals
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {queue.map(c => (
                <div
                  key={c.id}
                  className="rounded border bg-white/[0.02] p-2"
                  style={{ borderColor: `${confColor(c.score)}33` }}
                >
                  {/* Pair: secondary folds into primary */}
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex flex-col gap-1 min-w-0">
                      <button
                        onClick={() => onSelectEntity(c.secondaryId)}
                        className="flex items-center gap-1.5 text-left min-w-0"
                        title="Folds into the canonical node"
                      >
                        <TypeBadge type={c.secondaryType} />
                        <span className="text-[9px] font-mono text-white/80 truncate">{c.secondaryLabel}</span>
                      </button>
                      <div className="flex items-center gap-1 pl-0.5">
                        <GitMerge className="w-2.5 h-2.5" style={{ color: IDENTITY_COLOR }} />
                        <span className="text-[7px] font-mono text-white/30">into</span>
                      </div>
                      <button
                        onClick={() => onSelectEntity(c.primaryId)}
                        className="flex items-center gap-1.5 text-left min-w-0"
                        title="Surviving canonical node"
                      >
                        <TypeBadge type={c.primaryType} />
                        <span className="text-[9px] font-mono text-white/90 font-bold truncate">{c.primaryLabel}</span>
                      </button>
                    </div>
                    <div className="flex flex-col items-end flex-shrink-0">
                      <span className="text-[15px] font-mono font-bold leading-none" style={{ color: confColor(c.score) }}>
                        {Math.round(c.score * 100)}%
                      </span>
                      <span className="text-[6px] font-mono text-white/30 tracking-wider mt-0.5">CONFIDENCE</span>
                    </div>
                  </div>

                  {/* Confidence bar */}
                  <div className="h-1 rounded-full bg-white/10 overflow-hidden mb-1.5">
                    <div className="h-full rounded-full" style={{ width: `${Math.round(c.score * 100)}%`, backgroundColor: confColor(c.score) }} />
                  </div>

                  {/* Signal chips */}
                  <div className="flex flex-wrap gap-1 mb-2">
                    {c.signals.map(s => (
                      <span
                        key={s.key}
                        title={s.detail}
                        className="text-[6px] font-mono px-1 py-0.5 rounded bg-white/[0.04] border border-white/10 text-white/60"
                      >
                        {s.label} · {Math.round(s.score * 100)}%
                      </span>
                    ))}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => onMerge(c.primaryId, c.secondaryId, c)}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[8px] font-mono font-bold transition-colors"
                      style={{ backgroundColor: `${IDENTITY_COLOR}22`, color: IDENTITY_COLOR, border: `1px solid ${IDENTITY_COLOR}44` }}
                    >
                      <UserCheck className="w-3 h-3" />
                      MERGE
                    </button>
                    <button
                      onClick={() => onReject(c)}
                      className="flex items-center justify-center gap-1 px-2 py-1 rounded text-[8px] font-mono transition-colors bg-white/5 hover:bg-[#FF6D6D]/15 text-white/50 hover:text-[#FF6D6D] border border-white/10"
                      title="Mark as different people — suppress this pair"
                    >
                      <UserX className="w-3 h-3" />
                      NOT SAME
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── MERGED IDENTITIES (split to reverse) ── */}
        {merged.length > 0 && (
          <div className="pt-1 border-t border-white/10">
            <div className="flex items-center gap-1.5 mb-2">
              <Network className="w-3 h-3 text-white/50" />
              <span className="text-[8px] font-mono font-bold tracking-wider text-white/60">
                UNIFIED IDENTITIES ({merged.length})
              </span>
            </div>
            <div className="space-y-2">
              {merged.map(({ entity, records }) => (
                <div key={entity.id} className="rounded border border-white/10 bg-white/[0.02] p-2">
                  <button
                    onClick={() => onSelectEntity(entity.id)}
                    className="flex items-center gap-1.5 mb-1.5 text-left w-full"
                  >
                    <TypeBadge type={entity.type} />
                    <span className="text-[9px] font-mono text-white/90 font-bold truncate">{entity.label}</span>
                    <span className="text-[7px] font-mono text-white/30 ml-auto whitespace-nowrap">
                      {records.length} source{records.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  <div className="space-y-1">
                    {records.map(r => (
                      <div key={r.recordId} className="flex items-center gap-1.5">
                        <TypeBadge type={r.entity.type} />
                        <span className="text-[8px] font-mono text-white/60 truncate flex-1">{r.entity.label}</span>
                        {r.score > 0 && (
                          <span className="text-[7px] font-mono" style={{ color: confColor(r.score) }}>
                            {Math.round(r.score * 100)}%
                          </span>
                        )}
                        <button
                          onClick={() => onSplit(entity.id, r.recordId)}
                          className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[7px] font-mono transition-colors bg-white/5 hover:bg-[#FFD166]/15 text-white/50 hover:text-[#FFD166] border border-white/10"
                          title="Split this source back out into its own node"
                        >
                          <Split className="w-2.5 h-2.5" />
                          SPLIT
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
