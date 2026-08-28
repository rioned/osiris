'use client';

import { useState, useRef, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  GitMerge, Search, X, Maximize2, Minimize2, Loader2, Upload, FileText,
  Link2, Crosshair, ChevronRight, CheckCircle2, Sparkles, Database, Globe2,
} from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════
   OSIRIS — Data Fusion Panel
   Palantir-style fusion: one search box across structured entities
   (people, vessels, phones, ...) AND unstructured documents (reports,
   pages, OCR/PDF text), every hit already wired to its graph
   relationships. Also the ingestion front door for unstructured
   material — upload / paste / URL → chunked, indexed, NER'd, and
   fused into the same entity graph (see /api/fusion/*).
   ═══════════════════════════════════════════════════════════════ */

interface Neighbor { id: string; label: string; type: string; relation?: string; strength?: number }
interface EntityHit {
  id: string; type: string; domain: string; label: string; description?: string;
  coordinates?: { lat: number; lng: number }; tags: string[]; source: string;
  neighbors: Neighbor[]; relationCount: number;
}
interface DocumentHit {
  sourceId: string; docEntityId: string; chunkId: string; title: string;
  uri?: string; kind: string; snippet: string; rank: number;
  linkedEntities: Neighbor[];
}
interface IngestSummary {
  sourceId: string; docEntityId: string; deduped: boolean; chunkCount: number;
  entitiesLinked: { id: string; label: string; type: string; created: boolean; mentions: number }[];
  relationshipsCreated: number; summary: string;
}

const TYPE_COLORS: Record<string, string> = {
  person: '#B388FF', organization: '#C9A227', place: '#76FF03', vehicle: '#FF3D3D',
  vessel: '#2E8BC0', aircraft: '#5BC0EB', phone_number: '#00E5FF', email_address: '#4F6FFF',
  social_profile: '#FF6D00', network_node: '#00C2A8', event: '#FF9500', media: '#9B9B9B',
};
const typeColor = (t: string) => TYPE_COLORS[t] || '#8A8880';

function DataFusionPanelInner({ onLocate }: { onLocate: (lat: number, lng: number) => void }) {
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [mode, setMode] = useState<'search' | 'ingest'>('search');

  // Search state
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [entities, setEntities] = useState<EntityHit[]>([]);
  const [documents, setDocuments] = useState<DocumentHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);

  // Ingest state
  const [ingestTitle, setIngestTitle] = useState('');
  const [ingestText, setIngestText] = useState('');
  const [ingestUrl, setIngestUrl] = useState('');
  const [ingestMode, setIngestMode] = useState<'text' | 'file' | 'url'>('text');
  const [dragOver, setDragOver] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestResult, setIngestResult] = useState<IngestSummary | null>(null);
  const [ingestError, setIngestError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const runSearch = useCallback(async () => {
    if (!query.trim() || searching) return;
    setSearching(true); setSearched(true);
    try {
      const res = await fetch(`/api/fusion/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setEntities(data.entities || []);
      setDocuments(data.documents || []);
    } catch {
      setEntities([]); setDocuments([]);
    } finally {
      setSearching(false);
    }
  }, [query, searching]);

  const runIngest = useCallback(async () => {
    setIngesting(true); setIngestError(''); setIngestResult(null);
    try {
      let res: Response;
      if (ingestMode === 'file' && selectedFile) {
        const fd = new FormData();
        fd.append('file', selectedFile);
        if (ingestTitle) fd.append('title', ingestTitle);
        res = await fetch('/api/fusion/ingest', { method: 'POST', body: fd });
      } else if (ingestMode === 'url' && ingestUrl.trim()) {
        res = await fetch('/api/fusion/ingest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: ingestUrl.trim(), title: ingestTitle || undefined }),
        });
      } else if (ingestText.trim()) {
        res = await fetch('/api/fusion/ingest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: ingestText, title: ingestTitle || undefined, kind: 'text' }),
        });
      } else {
        setIngestError('Provide text, a file, or a URL to ingest');
        setIngesting(false);
        return;
      }
      const data = await res.json();
      if (!res.ok) { setIngestError(data.error || 'Ingest failed'); return; }
      setIngestResult(data);
      setIngestText(''); setIngestUrl(''); setSelectedFile(null); setIngestTitle('');
    } catch (e: any) {
      setIngestError(e.message || 'Network error');
    } finally {
      setIngesting(false);
    }
  }, [ingestMode, selectedFile, ingestUrl, ingestText, ingestTitle]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) { setSelectedFile(f); setIngestMode('file'); }
  }, []);

  const totalHits = entities.length + documents.length;

  const panelContent = (
    <>
      <button
        onClick={() => setOpen(!open)}
        className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors relative ${open ? 'bg-[#00C2A8]/20' : 'hover:bg-white/10'}`}
        title="DATA FUSION — unified search & ingest"
      >
        <GitMerge className={`w-4 h-4 ${open ? 'text-[#00C2A8]' : 'text-white/60'}`} />
      </button>

      {open && (
        <div className={`glass-panel overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col transition-all duration-300 ${
          maximized ? 'fixed inset-4 z-[9999] bg-[#0a0a09]/95 backdrop-blur-3xl max-h-none' : 'absolute right-12 top-1/2 -translate-y-1/2 w-[26rem] max-h-[85vh]'
        }`}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border-secondary)]">
            <div className="flex items-center gap-2">
              <GitMerge className="w-3.5 h-3.5 text-[#00C2A8]" />
              <span className="text-[12px] font-mono font-bold text-[var(--text-primary)] tracking-wider">DATA FUSION</span>
              <span className="gotham-tag gotham-tag--info" style={{ fontSize: '7px', padding: '1px 5px' }}>STRUCTURED + UNSTRUCTURED</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setMaximized(!maximized)} className="p-1 text-[var(--text-muted)] hover:text-[#00C2A8] transition-colors" title={maximized ? 'MINIMIZE' : 'FULLSCREEN'}>
                {maximized ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
              </button>
              <button onClick={() => setOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"><X className="w-3 h-3" /></button>
            </div>
          </div>

          {/* Mode tabs */}
          <div className="flex border-b border-[var(--border-secondary)]">
            {(['search', 'ingest'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] font-mono font-bold tracking-widest transition-colors ${
                  mode === m ? 'text-[#00C2A8] border-b-2 border-[#00C2A8] bg-[#00C2A8]/5' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}>
                {m === 'search' ? <Search className="w-3 h-3" /> : <Upload className="w-3 h-3" />}
                {m === 'search' ? 'FUSE SEARCH' : 'INGEST'}
              </button>
            ))}
          </div>

          {/* ── SEARCH MODE ── */}
          {mode === 'search' && (
            <div className="flex-1 overflow-y-auto styled-scrollbar flex flex-col min-h-0">
              <div className="p-2.5 flex gap-1.5 border-b border-[var(--border-secondary)]/50">
                <div className="flex-1 relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && runSearch()}
                    placeholder="Search entities & documents…"
                    className="w-full bg-[var(--bg-primary)]/60 border border-[var(--border-primary)] rounded-lg pl-8 pr-3 py-2 text-[11px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/40 focus:outline-none" />
                </div>
                <button onClick={runSearch} disabled={searching || !query.trim()}
                  className="px-3 py-2 rounded-lg text-[10px] font-mono font-bold disabled:opacity-30 flex items-center justify-center"
                  style={{ backgroundColor: '#00C2A820', border: '1px solid #00C2A840', color: '#00C2A8' }}>
                  {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'FUSE'}
                </button>
              </div>

              <div className={`flex-1 overflow-y-auto styled-scrollbar p-2.5 ${maximized ? '' : 'max-h-[55vh]'}`}>
                {!searched && (
                  <div className="px-2 py-6 text-center">
                    <Sparkles className="w-5 h-5 text-[var(--text-muted)]/40 mx-auto mb-2" />
                    <span className="text-[10px] font-mono text-[var(--text-muted)] tracking-widest">SEARCH ACROSS THE FUSED GRAPH</span>
                    <p className="text-[9px] font-mono text-[var(--text-muted)]/50 mt-1">Matches entities by name/tags and documents by full text — every hit shows its live relationships.</p>
                  </div>
                )}
                {searched && !searching && totalHits === 0 && (
                  <div className="px-2 py-6 text-center">
                    <span className="text-[10px] font-mono text-[var(--text-muted)] tracking-widest">NO FUSION HITS</span>
                  </div>
                )}

                {entities.length > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center gap-1.5 mb-1.5 px-0.5">
                      <Database className="w-3 h-3 text-[var(--text-muted)]" />
                      <span className="text-[8px] font-mono tracking-widest text-[var(--text-muted)]">STRUCTURED ENTITIES ({entities.length})</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {entities.map(e => (
                        <div key={e.id} className="p-2 rounded-lg border border-[var(--border-secondary)]/40 bg-[var(--bg-primary)]/30 hover:bg-[var(--hover-accent)] transition-colors">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor(e.type) }} />
                              <span className="text-[11px] font-mono font-bold text-[var(--text-primary)] truncate">{e.label}</span>
                              <span className="text-[8px] font-mono px-1 py-0.5 rounded flex-shrink-0" style={{ backgroundColor: `${typeColor(e.type)}20`, color: typeColor(e.type) }}>{e.type}</span>
                            </div>
                            {e.coordinates && (
                              <button onClick={() => onLocate(e.coordinates!.lat, e.coordinates!.lng)} title="LOCATE" className="p-1 text-[var(--text-muted)] hover:text-[#00C2A8] transition-colors flex-shrink-0">
                                <Crosshair className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          {e.description && <p className="text-[9px] font-mono text-[var(--text-secondary)] mt-1 line-clamp-2">{e.description}</p>}
                          {e.neighbors.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {e.neighbors.map((n, i) => (
                                <span key={i} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-black/30 border border-white/[0.06] text-[var(--text-muted)] flex items-center gap-1">
                                  <Link2 className="w-2 h-2" style={{ color: typeColor(n.type) }} />
                                  {n.relation} → {n.label}
                                </span>
                              ))}
                              {e.relationCount > e.neighbors.length && (
                                <span className="text-[8px] font-mono px-1.5 py-0.5 text-[var(--text-muted)]">+{e.relationCount - e.neighbors.length} more</span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {documents.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5 px-0.5">
                      <FileText className="w-3 h-3 text-[var(--text-muted)]" />
                      <span className="text-[8px] font-mono tracking-widest text-[var(--text-muted)]">DOCUMENTS ({documents.length})</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {documents.map(d => {
                        const isOpen = expandedDoc === d.chunkId;
                        return (
                          <div key={d.chunkId} className="p-2 rounded-lg border border-[var(--border-secondary)]/40 bg-[var(--bg-primary)]/30 hover:bg-[var(--hover-accent)] transition-colors cursor-pointer"
                            onClick={() => setExpandedDoc(isOpen ? null : d.chunkId)}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <FileText className="w-3 h-3 flex-shrink-0" style={{ color: typeColor('media') }} />
                                <span className="text-[11px] font-mono font-bold text-[var(--text-primary)] truncate">{d.title}</span>
                                <span className="text-[8px] font-mono px-1 py-0.5 rounded flex-shrink-0 bg-[#9B9B9B20] text-[#9B9B9B]">{d.kind}</span>
                              </div>
                              <ChevronRight className={`w-3 h-3 text-[var(--text-muted)] transition-transform flex-shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
                            </div>
                            <p className={`text-[9px] font-mono text-[var(--text-secondary)] mt-1 leading-relaxed ${isOpen ? '' : 'line-clamp-2'}`}>{d.snippet}</p>
                            {d.uri && isOpen && (
                              <a href={d.uri} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-[8px] font-mono text-[#00C2A8] hover:underline flex items-center gap-1 mt-1">
                                <Globe2 className="w-2.5 h-2.5" />{d.uri}
                              </a>
                            )}
                            {d.linkedEntities.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {d.linkedEntities.map((n, i) => (
                                  <span key={i} className="text-[8px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1" style={{ backgroundColor: `${typeColor(n.type)}15`, color: typeColor(n.type), border: `1px solid ${typeColor(n.type)}30` }}>
                                    {n.label}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── INGEST MODE ── */}
          {mode === 'ingest' && (
            <div className={`flex-1 overflow-y-auto styled-scrollbar p-2.5 flex flex-col gap-2 ${maximized ? '' : 'max-h-[65vh]'}`}>
              <div className="flex gap-1">
                {(['text', 'file', 'url'] as const).map(m => (
                  <button key={m} onClick={() => setIngestMode(m)}
                    className={`flex-1 py-1.5 rounded text-[9px] font-mono font-bold tracking-wider transition-colors ${
                      ingestMode === m ? 'bg-[#00C2A8]/20 text-[#00C2A8] border border-[#00C2A8]/40' : 'text-[var(--text-muted)] border border-transparent hover:bg-[var(--hover-accent)]'
                    }`}>{m.toUpperCase()}</button>
                ))}
              </div>

              <input value={ingestTitle} onChange={e => setIngestTitle(e.target.value)} placeholder="Title (optional)"
                className="w-full bg-[var(--bg-primary)]/60 border border-[var(--border-primary)] rounded-lg px-3 py-2 text-[11px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/40 focus:outline-none" />

              {ingestMode === 'text' && (
                <textarea value={ingestText} onChange={e => setIngestText(e.target.value)} rows={7}
                  placeholder="Paste report text, transcript, or any unstructured content…"
                  className="w-full bg-[var(--bg-primary)]/60 border border-[var(--border-primary)] rounded-lg px-3 py-2 text-[10px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/40 focus:outline-none resize-none" />
              )}

              {ingestMode === 'url' && (
                <input value={ingestUrl} onChange={e => setIngestUrl(e.target.value)} placeholder="https://…"
                  className="w-full bg-[var(--bg-primary)]/60 border border-[var(--border-primary)] rounded-lg px-3 py-2 text-[11px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/40 focus:outline-none" />
              )}

              {ingestMode === 'file' && (
                <div
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${dragOver ? 'border-[#00C2A8] bg-[#00C2A8]/10' : 'border-[var(--border-secondary)] hover:border-[var(--border-primary)]'}`}
                >
                  <Upload className="w-5 h-5 mx-auto mb-1.5 text-[var(--text-muted)]" />
                  <p className="text-[9px] font-mono text-[var(--text-muted)]">{selectedFile ? selectedFile.name : 'Drop a PDF / image / text file, or click to browse'}</p>
                  <input ref={fileInputRef} type="file" className="hidden" accept=".pdf,.txt,.md,.csv,.log,.json,.png,.jpg,.jpeg,.webp"
                    onChange={e => setSelectedFile(e.target.files?.[0] || null)} />
                </div>
              )}

              <button onClick={runIngest} disabled={ingesting}
                className="w-full py-2.5 rounded-lg font-mono text-[11px] tracking-wider font-bold transition-all hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, rgba(0,194,168,0.2), rgba(57,255,20,0.15))', border: '1px solid rgba(0,194,168,0.5)', color: '#00C2A8' }}>
                {ingesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
                {ingesting ? 'FUSING…' : 'FUSE INTO GRAPH'}
              </button>

              {ingestError && (
                <div className="p-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[10px] font-mono text-red-400">{ingestError}</div>
              )}

              {ingestResult && (
                <div className="p-3 rounded-lg border border-[#00C2A8]/30 bg-[#00C2A8]/5">
                  <div className="flex items-center gap-1.5 mb-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#00C2A8]" />
                    <span className="text-[10px] font-mono font-bold text-[#00C2A8]">{ingestResult.deduped ? 'ALREADY FUSED' : 'FUSED'}</span>
                  </div>
                  <p className="text-[9px] font-mono text-[var(--text-secondary)] mb-2">{ingestResult.summary}</p>
                  <div className="flex gap-3 mb-2">
                    <div><div className="text-[13px] font-mono font-bold text-[var(--text-primary)]">{ingestResult.chunkCount}</div><div className="text-[7px] font-mono text-[var(--text-muted)] tracking-wider">CHUNKS</div></div>
                    <div><div className="text-[13px] font-mono font-bold text-[var(--text-primary)]">{ingestResult.entitiesLinked.length}</div><div className="text-[7px] font-mono text-[var(--text-muted)] tracking-wider">ENTITIES</div></div>
                    <div><div className="text-[13px] font-mono font-bold text-[var(--text-primary)]">{ingestResult.relationshipsCreated}</div><div className="text-[7px] font-mono text-[var(--text-muted)] tracking-wider">RELATIONS</div></div>
                  </div>
                  {ingestResult.entitiesLinked.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {ingestResult.entitiesLinked.map((e, i) => (
                        <span key={i} className="text-[8px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1" style={{ backgroundColor: `${typeColor(e.type)}15`, color: typeColor(e.type), border: `1px solid ${typeColor(e.type)}30` }}>
                          {e.created && <Sparkles className="w-2 h-2" />}{e.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );

  if (maximized && typeof document !== 'undefined') return createPortal(panelContent, document.body);
  return panelContent;
}

export default memo(DataFusionPanelInner);
