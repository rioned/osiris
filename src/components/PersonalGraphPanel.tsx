'use client';

import { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import dynamic from 'next/dynamic';
import {
  X, Maximize2, Minimize2, Loader2, AlertTriangle,
  User, Phone, AtSign, CreditCard, Car, MapPin,
  Wifi, Globe, Calendar, Image, Search, Plus,
  Network, Eye, EyeOff, Crosshair, RefreshCw, Layers,
  MessageCircle, Send, Bot, Share2, GitBranch,
  Activity, Users, Route, Zap
} from 'lucide-react';
import {
  PersonalEntity, PersonalEntityType, PersonalGraphData,
  PersonalGraphNode, PersonalGraphLink,
  PERSONAL_TYPE_COLORS, PERSONAL_TYPE_LABELS,
  PersonalStore, PersonalDomain,
  loadPersonalStore, savePersonalStore, buildGraph,
  crossReferenceStore, generateEntityId, makeRelationship,
} from '@/lib/personal-ontology';
import {
  analyzeGraph, findShortestPath, communityColor,
  type GraphAnalyticsResult, type PathResult,
} from '@/lib/graph-analytics';
import { useAuth } from './AuthProvider';

type CentralityMetric = 'degree' | 'betweenness' | 'closeness' | 'eigenvector';

const CENTRALITY_LABELS: Record<CentralityMetric, string> = {
  degree: 'DEGREE',
  betweenness: 'BETWEENNESS',
  closeness: 'CLOSENESS',
  eigenvector: 'EIGENVECTOR',
};

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });
const LinkEditorGraph = dynamic(() => import('./LinkEditorGraph'), { ssr: false });

type GraphViewMode = 'force' | 'editor';

// ── Icon Map ──
const TYPE_ICONS: Record<string, React.ComponentType<any>> = {
  person: User, phone_number: Phone, social_profile: AtSign,
  personal_id: CreditCard, vehicle: Car, place: MapPin,
  mac_address: Wifi, wifi_network: Globe, event: Calendar, image_media: Image,
};

interface Props {
  show: boolean;
  onClose: () => void;
  onLocate: (lat: number, lng: number) => void;
  mapVisible: boolean;
  onToggleMap: () => void;
}

function PersonalGraphPanelInner({ show, onClose, onLocate, mapVisible, onToggleMap }: Props) {
  const { user } = useAuth();
  const uid = user?.id;  // namespaces this analyst's workspace (isolation)
  const [store, setStore] = useState<PersonalStore>({ entities: [], relationships: [], version: 1 });
  const [graphData, setGraphData] = useState<PersonalGraphData>({ nodes: [], links: [] });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<PersonalGraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [activeFilter, setActiveFilter] = useState<PersonalEntityType | 'all'>('all');
  const [viewMode, setViewMode] = useState<GraphViewMode>('force');
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // AI Chat state
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── Advanced graph analytics state ──
  // Community detection (Louvain), centrality scoring and pathfinding all run
  // client-side over the in-memory store, so they layer on top of the existing
  // force graph without any server round-trip or change to the data model.
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [centralityMetric, setCentralityMetric] = useState<CentralityMetric>('degree');
  // Pathfinding: pick two nodes on the canvas to reveal how they connect.
  const [pathMode, setPathMode] = useState(false);
  const [pathSource, setPathSource] = useState<string | null>(null);
  const [pathTarget, setPathTarget] = useState<string | null>(null);

  // Load store on mount (and when the active user changes — workspace isolation)
  useEffect(() => {
    if (!show) return;
    const loaded = loadPersonalStore(uid);
    setStore(loaded);
    rebuildGraph(loaded);
  }, [show, uid]);

  const rebuildGraph = useCallback((s: PersonalStore) => {
    const graph = buildGraph(s);
    // Filter if needed
    setGraphData(graph);
  }, []);

  // Auto cross-reference on new entities
  useEffect(() => {
    if (store.entities.length === 0) return;
    const newRels = crossReferenceStore(store);
    if (newRels.length > 0) {
      const updated = { ...store, relationships: [...store.relationships, ...newRels] };
      setStore(updated);
      savePersonalStore(updated, uid);
      rebuildGraph(updated);
    }
  }, [store.entities.length]);

  // AI Chat: Send query
  const handleChatSend = useCallback(async () => {
    if (!chatInput.trim() || chatLoading) return;
    const query = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: query }]);
    setChatLoading(true);
    try {
      const res = await fetch('/api/ai/ontology-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'query',
          query,
          store: { entities: store.entities, relationships: store.relationships },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setChatMessages(prev => [...prev, { role: 'assistant', content: data.analysis || 'No response' }]);
      } else {
        setChatMessages(prev => [...prev, { role: 'assistant', content: 'Query failed. Check API key.' }]);
      }
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Connection error.' }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, store]);

  const handleAddEntity = useCallback(async (entity: PersonalEntity) => {
    const updated = { ...store, entities: [...store.entities, entity] };
    setStore(updated);
    savePersonalStore(updated, uid);
    rebuildGraph(updated);
    setShowAddForm(false);
  }, [store, rebuildGraph]);

  const handleNodeClick = useCallback((node: any) => {
    const n = node as PersonalGraphNode;
    // Pathfinding pick mode: first click sets the source, second the target.
    if (pathMode) {
      setPathSource(prevSrc => {
        if (!prevSrc) { setPathTarget(null); return n.id; }
        if (prevSrc === n.id) return prevSrc;
        setPathTarget(n.id);
        return prevSrc;
      });
      return;
    }
    setSelectedNode(n);
    if (graphRef.current) {
      graphRef.current.centerAt(n.x, n.y, 500);
      graphRef.current.zoom(3, 500);
    }
  }, [pathMode]);

  // Clear all pathfinding selections.
  const clearPath = useCallback(() => {
    setPathSource(null);
    setPathTarget(null);
  }, []);

  const handleLocateNode = useCallback((node: PersonalGraphNode) => {
    if (node.coordinates) {
      onLocate(node.coordinates.lat, node.coordinates.lng);
    }
  }, [onLocate]);

  const handleDeleteEntity = useCallback((id: string) => {
    const updated = {
      ...store,
      entities: store.entities.filter(e => e.id !== id),
      relationships: store.relationships.filter(r => r.sourceId !== id && r.targetId !== id),
    };
    setStore(updated);
    savePersonalStore(updated, uid);
    rebuildGraph(updated);
    setSelectedNode(null);
  }, [store, rebuildGraph]);

  // ── Link Editor handlers (shared store) ──
  // Draw a relationship by hand. Skip exact duplicates (same pair + label).
  const handleCreateRelationship = useCallback((sourceId: string, targetId: string) => {
    const rel = makeRelationship(sourceId, targetId, 'linked_to', 1);
    const dup = store.relationships.some(
      r => r.sourceId === sourceId && r.targetId === targetId && r.label === rel.label,
    );
    if (dup) return;
    const updated = { ...store, relationships: [...store.relationships, rel] };
    setStore(updated);
    savePersonalStore(updated, uid);
    rebuildGraph(updated);
  }, [store, rebuildGraph]);

  const handleDeleteRelationship = useCallback((id: string) => {
    const updated = { ...store, relationships: store.relationships.filter(r => r.id !== id) };
    setStore(updated);
    savePersonalStore(updated, uid);
    rebuildGraph(updated);
  }, [store, rebuildGraph]);

  // Persist a node's canvas position so the hand-drawn layout survives reloads.
  const handleMoveEntity = useCallback((id: string, pos: { x: number; y: number }) => {
    const updated = {
      ...store,
      entities: store.entities.map(e => (e.id === id ? { ...e, graphPos: pos } : e)),
    };
    setStore(updated);
    savePersonalStore(updated, uid);
  }, [store]);

  const handleSelectEntityById = useCallback((id: string) => {
    const node = graphData.nodes.find(n => n.id === id);
    if (node) setSelectedNode(node);
  }, [graphData.nodes]);

  // Search filter
  const filteredNodes = searchQuery
    ? graphData.nodes.filter(n =>
        n.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        n.type.toLowerCase().includes(searchQuery.toLowerCase()) ||
        JSON.stringify(n.properties).toLowerCase().includes(searchQuery.toLowerCase())
      )
    : graphData.nodes;

  const filteredLinks = searchQuery
    ? graphData.links.filter(l => {
        const src = filteredNodes.find(n => n.id === (typeof l.source === 'string' ? l.source : l.source.id));
        const tgt = filteredNodes.find(n => n.id === (typeof l.target === 'string' ? l.target : l.target.id));
        return src && tgt;
      })
    : graphData.links;

  // Type filter
  const typeFilteredNodes = activeFilter === 'all'
    ? filteredNodes
    : filteredNodes.filter(n => n.type === activeFilter);

  const typeFilteredLinks = filteredLinks.filter(l => {
    const src = typeFilteredNodes.find(n => n.id === (typeof l.source === 'string' ? l.source : l.source.id));
    const tgt = typeFilteredNodes.find(n => n.id === (typeof l.target === 'string' ? l.target : l.target.id));
    return src && tgt;
  });

  const displayGraph: PersonalGraphData = { nodes: typeFilteredNodes, links: typeFilteredLinks };

  // ── Analytics computation ──
  // Runs Louvain community detection + centrality over the raw store graph
  // (string-id links, before the force layout mutates them into object refs).
  // Memoised on the entity/relationship counts so it only recomputes when the
  // graph actually changes — keeps the force simulation smooth.
  const analytics: GraphAnalyticsResult | null = useMemo(() => {
    if (!showAnalytics || store.entities.length === 0) return null;
    return analyzeGraph({
      nodes: store.entities.map(e => ({ id: e.id })),
      links: store.relationships.map(r => ({ source: r.sourceId, target: r.targetId, strength: r.strength })),
    });
  }, [showAnalytics, store.entities.length, store.relationships.length]);

  // Shortest path between the two picked endpoints.
  const pathResult: PathResult | null = useMemo(() => {
    if (!pathSource || !pathTarget) return null;
    return findShortestPath(
      {
        nodes: store.entities.map(e => ({ id: e.id })),
        links: store.relationships.map(r => ({ source: r.sourceId, target: r.targetId, strength: r.strength })),
      },
      pathSource, pathTarget,
    );
  }, [pathSource, pathTarget, store.entities.length, store.relationships.length]);

  // Fast lookups used by the canvas painters.
  const pathNodeSet = useMemo(() => new Set(pathResult?.path || []), [pathResult]);
  const pathEdgeSet = useMemo(() => {
    const s = new Set<string>();
    for (const [a, b] of pathResult?.edges || []) {
      s.add(`${a}>${b}`); s.add(`${b}>${a}`);
    }
    return s;
  }, [pathResult]);

  const selectedCentrality = analytics?.centrality?.[centralityMetric] || null;

  const entityLabelById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of store.entities) m[e.id] = e.label;
    return m;
  }, [store.entities]);

  // Node painter
  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as PersonalGraphNode;
    const isSelected = n === selectedNode;

    // In analytics mode, colour by community and size by the chosen centrality
    // metric; otherwise keep the original per-type colouring.
    const community = analytics?.community.communityOf[n.id];
    const baseColor = PERSONAL_TYPE_COLORS[n.type] || '#888';
    const color = showAnalytics && community !== undefined ? communityColor(community) : baseColor;

    let size = isSelected ? 6 : 4;
    if (showAnalytics && selectedCentrality) {
      // Scale radius 3..11 by centrality so influential nodes pop visually.
      size = 3 + (selectedCentrality[n.id] || 0) * 8 + (isSelected ? 2 : 0);
    }

    // Pathfinding endpoints / route emphasis.
    const isPathEndpoint = n.id === pathSource || n.id === pathTarget;
    const isOnPath = pathNodeSet.has(n.id);
    if (isOnPath) size = Math.max(size, 5.5);

    ctx.beginPath();
    ctx.arc(n.x!, n.y!, size, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isPathEndpoint ? '#FFD166' : isOnPath ? '#00E5FF' : isSelected ? '#fff' : 'rgba(0,0,0,0.8)';
    ctx.lineWidth = isPathEndpoint || isOnPath ? 2 : 1;
    ctx.stroke();

    if (isSelected || isPathEndpoint || isOnPath) {
      const glow = isPathEndpoint ? '#FFD166' : isOnPath ? '#00E5FF' : color;
      ctx.shadowColor = glow;
      ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(n.x!, n.y!, size + 4, 0, 2 * Math.PI);
      ctx.strokeStyle = `${glow}60`;
      ctx.lineWidth = 1.5; ctx.stroke();
      ctx.shadowBlur = 0;
    }

    const fontSize = Math.max(11 / globalScale, 3);
    if (fontSize > 3.5 || isSelected || isPathEndpoint) {
      ctx.font = `${isSelected ? 'bold ' : ''}${fontSize}px 'JetBrains Mono', monospace`;
      const label = n.label.length > 24 ? n.label.slice(0, 22) + '…' : n.label;
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(n.x! - textWidth / 2 - 3, n.y! + size + 3, textWidth + 6, fontSize + 3);
      ctx.fillStyle = isSelected ? '#fff' : color;
      ctx.fillText(label, n.x!, n.y! + size + 5);
    }
  }, [selectedNode, showAnalytics, analytics, selectedCentrality, pathSource, pathTarget, pathNodeSet]);

  const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const s = link.source; const t = link.target;
    if (!s.x || !t.x) return;
    const sId = typeof s === 'string' ? s : s.id;
    const tId = typeof t === 'string' ? t : t.id;
    const onPath = pathEdgeSet.has(`${sId}>${tId}`);

    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y);
    if (onPath) {
      // Highlight the discovered route between the two picked entities.
      ctx.strokeStyle = '#00E5FF';
      ctx.lineWidth = Math.max(1.5, 3 / globalScale);
      ctx.shadowColor = '#00E5FF';
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
      return;
    }
    // Dim non-path edges while a path is shown, to make the route stand out.
    const dim = pathResult?.reachable ? 0.04 : Math.max(0.05, link.strength || 0.1);
    ctx.strokeStyle = `rgba(255,255,255,${dim})`;
    ctx.lineWidth = Math.max(0.5, (link.strength || 0.5) * 2 / globalScale);
    ctx.stroke();
  }, [pathEdgeSet, pathResult]);

  if (!show) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[400] flex flex-col"
      style={{ background: 'radial-gradient(ellipse at center, #0a0a14 0%, #050508 100%)' }}
    >
      {/* HEADER */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-black/40">
        <div className="flex items-center gap-3">
          <Network className="w-4 h-4 text-[var(--gold-primary)] animate-osiris-pulse" />
          <span className="text-[12px] font-mono font-bold tracking-[0.2em] text-[var(--gold-primary)]">PERSONAL ONTOLOGY GRAPH</span>
          <span className="text-[9px] font-mono text-white/40">{graphData.nodes.length} NODES · {graphData.links.length} LINKS</span>
          {loading && <Loader2 className="w-3 h-3 text-[var(--gold-primary)] animate-spin" />}
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle: auto-layout force graph ⇄ interactive link editor */}
          <div className="flex items-center rounded overflow-hidden border border-white/10">
            <button onClick={() => setViewMode('force')}
              title="Auto-layout force graph"
              className="flex items-center gap-1 px-2 py-1 text-[8px] font-mono transition-colors"
              style={{
                backgroundColor: viewMode === 'force' ? 'rgba(212,175,55,0.15)' : 'rgba(255,255,255,0.03)',
                color: viewMode === 'force' ? '#D4AF37' : 'rgba(255,255,255,0.5)',
              }}>
              <Share2 className="w-3 h-3" />
              FORCE
            </button>
            <button onClick={() => setViewMode('editor')}
              title="Interactive link editor — drag to connect"
              className="flex items-center gap-1 px-2 py-1 text-[8px] font-mono transition-colors"
              style={{
                backgroundColor: viewMode === 'editor' ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.03)',
                color: viewMode === 'editor' ? '#00E5FF' : 'rgba(255,255,255,0.5)',
              }}>
              <GitBranch className="w-3 h-3" />
              LINK EDITOR
            </button>
          </div>
          {/* Map toggle */}
          <button onClick={onToggleMap}
            className="flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono transition-colors"
            style={{
              backgroundColor: mapVisible ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.05)',
              color: mapVisible ? '#00E5FF' : 'rgba(255,255,255,0.5)',
              border: `1px solid ${mapVisible ? 'rgba(0,229,255,0.3)' : 'rgba(255,255,255,0.1)'}`,
            }}>
            {mapVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            MAP
          </button>
          <button onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono transition-colors"
            style={{ backgroundColor: 'rgba(212,175,55,0.15)', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.3)' }}>
            <Plus className="w-3 h-3" />
            ADD ENTITY
          </button>
          {/* Analytics button — community detection, centrality, pathfinding */}
          <button onClick={() => { setShowAnalytics(v => !v); if (showAnalytics) { setPathMode(false); clearPath(); } }}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono transition-colors ${showAnalytics ? 'bg-[#06D6A0]/20' : 'bg-white/5 hover:bg-white/10'}`}
            style={{ color: showAnalytics ? '#06D6A0' : 'rgba(255,255,255,0.5)', border: `1px solid ${showAnalytics ? 'rgba(6,214,160,0.3)' : 'rgba(255,255,255,0.1)'}` }}>
            <Activity className="w-3 h-3" />
            ANALYTICS
          </button>
          {/* AI Chat button */}
          <button onClick={() => setShowChat(!showChat)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono transition-colors ${showChat ? 'bg-[#B388FF]/20' : 'bg-white/5 hover:bg-white/10'}`}
            style={{ color: showChat ? '#B388FF' : 'rgba(255,255,255,0.5)', border: `1px solid ${showChat ? 'rgba(179,136,255,0.3)' : 'rgba(255,255,255,0.1)'}` }}>
            <MessageCircle className="w-3 h-3" />
            AI CHAT
          </button>
          <button onClick={onClose}
            className="p-1 hover:bg-[#FF1744]/20 rounded transition-colors">
            <X className="w-4 h-4 text-[#FF1744]" />
          </button>
        </div>
      </div>

      {/* CHAT PANEL (right sidebar) */}
      <AnimatePresence>
        {showChat && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 360, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="absolute right-0 top-0 bottom-0 z-50 border-l border-white/10 bg-black/95 backdrop-blur-md flex flex-col"
          >
            {/* Chat Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Bot className="w-3.5 h-3.5 text-[#B388FF]" />
                <span className="text-[10px] font-mono font-bold tracking-wider text-[#B388FF]">ONTOLOGY AI</span>
              </div>
              <button onClick={() => setShowChat(false)} className="text-white/40 hover:text-white p-1">
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto styled-scrollbar p-3 space-y-2">
              {chatMessages.length === 0 && (
                <div className="text-center py-6">
                  <Bot className="w-8 h-8 mx-auto mb-2 text-white/20" />
                  <p className="text-[9px] font-mono text-white/30">Ask questions about your ontology data</p>
                  <p className="text-[7px] font-mono text-white/20 mt-1">e.g. "Who is connected to John Smith?" or "Show all vehicles"</p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex gap-1.5 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  {msg.role === 'assistant' && <Bot className="w-3 h-3 mt-1 text-[#B388FF] flex-shrink-0" />}
                  <div className={`px-2 py-1.5 rounded text-[8px] font-mono leading-relaxed max-w-[85%] ${
                    msg.role === 'user'
                      ? 'bg-[#B388FF]/15 text-white border border-[#B388FF]/20'
                      : 'bg-white/5 text-white/80 border border-white/10'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <div className="w-2 h-2 border border-[#B388FF] border-t-transparent rounded-full animate-spin" />
                  <span className="text-[8px] font-mono text-white/40">Analyzing...</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="p-2 border-t border-white/10">
              <div className="flex items-center gap-1.5">
                <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                  placeholder="ASK ABOUT YOUR DATA..."
                  className="flex-1 bg-black/40 text-[8px] font-mono text-white px-2 py-1.5 rounded outline-none border border-white/10 focus:border-[#B388FF] placeholder:text-white/20"
                  onKeyDown={e => e.key === 'Enter' && handleChatSend()}
                />
                <button onClick={handleChatSend} disabled={!chatInput.trim() || chatLoading}
                  className="p-1.5 rounded text-white/60 hover:text-[#B388FF] hover:bg-[#B388FF]/10 transition-colors disabled:opacity-30">
                  <Send className="w-3 h-3" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ANALYTICS PANEL (left sidebar) */}
      <AnimatePresence>
        {showAnalytics && (
          <motion.div
            initial={{ x: -380, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -380, opacity: 0 }}
            transition={{ type: 'tween', duration: 0.25 }}
            className="absolute left-0 top-0 bottom-0 z-50 w-[340px] border-r border-white/10 bg-black/95 backdrop-blur-md flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-[#06D6A0]" />
                <span className="text-[10px] font-mono font-bold tracking-wider text-[#06D6A0]">GRAPH ANALYTICS</span>
              </div>
              <button onClick={() => { setShowAnalytics(false); setPathMode(false); clearPath(); }} className="text-white/40 hover:text-white p-1">
                <X className="w-3 h-3" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto styled-scrollbar p-3 space-y-4">
              {!analytics ? (
                <div className="text-center py-8">
                  <Network className="w-8 h-8 mx-auto mb-2 text-white/20" />
                  <p className="text-[9px] font-mono text-white/30">Add entities and relationships</p>
                  <p className="text-[8px] font-mono text-white/20 mt-1">to run community detection & centrality</p>
                </div>
              ) : (
                <>
                  {/* Summary stats */}
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { label: 'NODES', value: analytics.stats.nodeCount, color: '#fff' },
                      { label: 'EDGES', value: analytics.stats.edgeCount, color: '#fff' },
                      { label: 'COMMUNITIES', value: analytics.community.count, color: '#06D6A0' },
                      { label: 'MODULARITY', value: analytics.community.modularity.toFixed(3), color: '#FFD166' },
                      { label: 'DENSITY', value: analytics.stats.density.toFixed(3), color: '#00E5FF' },
                      { label: 'ISOLATED', value: analytics.stats.isolatedNodes.length, color: '#FF6D00' },
                    ].map(s => (
                      <div key={s.label} className="rounded border border-white/10 bg-white/[0.02] px-2 py-1.5">
                        <div className="text-[7px] font-mono text-white/40">{s.label}</div>
                        <div className="text-[13px] font-mono font-bold" style={{ color: s.color }}>{s.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Centrality metric selector */}
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Zap className="w-3 h-3 text-[#FFD166]" />
                      <span className="text-[8px] font-mono font-bold tracking-wider text-white/60">CENTRALITY · NODE SIZE</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      {(Object.keys(CENTRALITY_LABELS) as CentralityMetric[]).map(m => (
                        <button key={m} onClick={() => setCentralityMetric(m)}
                          className="px-1.5 py-1 rounded text-[7px] font-mono transition-colors"
                          style={{
                            backgroundColor: centralityMetric === m ? 'rgba(255,209,102,0.15)' : 'rgba(255,255,255,0.03)',
                            color: centralityMetric === m ? '#FFD166' : 'rgba(255,255,255,0.5)',
                            border: `1px solid ${centralityMetric === m ? 'rgba(255,209,102,0.3)' : 'rgba(255,255,255,0.08)'}`,
                          }}>
                          {CENTRALITY_LABELS[m]}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Top influencers */}
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Crosshair className="w-3 h-3 text-[#EF476F]" />
                      <span className="text-[8px] font-mono font-bold tracking-wider text-white/60">TOP INFLUENCERS</span>
                    </div>
                    <div className="space-y-1">
                      {analytics.topInfluencers.filter(t => t.score > 0).slice(0, 6).map((t, i) => (
                        <button key={t.id} onClick={() => handleSelectEntityById(t.id)}
                          className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-white/5 transition-colors text-left">
                          <span className="text-[8px] font-mono text-white/30 w-3">{i + 1}</span>
                          <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: communityColor(analytics.community.communityOf[t.id] ?? -1) }} />
                          <span className="text-[8px] font-mono text-white/80 flex-1 truncate">{entityLabelById[t.id] || t.id}</span>
                          <div className="w-12 h-1 rounded-full bg-white/10 overflow-hidden flex-shrink-0">
                            <div className="h-full rounded-full" style={{ width: `${Math.round(t.score * 100)}%`, backgroundColor: '#EF476F' }} />
                          </div>
                        </button>
                      ))}
                      {analytics.topInfluencers.filter(t => t.score > 0).length === 0 && (
                        <p className="text-[8px] font-mono text-white/20 px-1.5">No connected entities yet</p>
                      )}
                    </div>
                  </div>

                  {/* Communities */}
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Users className="w-3 h-3 text-[#06D6A0]" />
                      <span className="text-[8px] font-mono font-bold tracking-wider text-white/60">COMMUNITIES ({analytics.community.count})</span>
                    </div>
                    <div className="space-y-1">
                      {analytics.community.communities
                        .map((members, idx) => ({ members, idx }))
                        .sort((a, b) => b.members.length - a.members.length)
                        .slice(0, 8)
                        .map(({ members, idx }) => (
                          <div key={idx} className="flex items-center gap-2 px-1.5 py-1 rounded bg-white/[0.02]">
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: communityColor(idx) }} />
                            <span className="text-[8px] font-mono text-white/70 flex-1">Cluster {idx + 1}</span>
                            <span className="text-[8px] font-mono text-white/40">{members.length} {members.length === 1 ? 'node' : 'nodes'}</span>
                          </div>
                        ))}
                    </div>
                  </div>

                  {/* Bridges — hidden connections */}
                  {analytics.bridges.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <GitBranch className="w-3 h-3 text-[#B388FF]" />
                        <span className="text-[8px] font-mono font-bold tracking-wider text-white/60">BRIDGES · HIDDEN LINKS</span>
                      </div>
                      <div className="space-y-1">
                        {analytics.bridges.slice(0, 6).map((b, i) => (
                          <button key={i} onClick={() => { setPathSource(b.source); setPathTarget(b.target); }}
                            className="w-full flex items-center gap-1 px-1.5 py-1 rounded bg-white/[0.02] hover:bg-white/5 transition-colors text-left">
                            <span className="text-[8px] font-mono text-white/70 truncate max-w-[90px]">{entityLabelById[b.source] || b.source}</span>
                            <Route className="w-2.5 h-2.5 text-[#B388FF] flex-shrink-0" />
                            <span className="text-[8px] font-mono text-white/70 truncate max-w-[90px]">{entityLabelById[b.target] || b.target}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Pathfinding */}
                  <div className="pt-1 border-t border-white/10">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <Route className="w-3 h-3 text-[#00E5FF]" />
                        <span className="text-[8px] font-mono font-bold tracking-wider text-white/60">PATHFINDING</span>
                      </div>
                      <button onClick={() => { setPathMode(v => !v); if (pathMode) clearPath(); }}
                        className="px-1.5 py-0.5 rounded text-[7px] font-mono transition-colors"
                        style={{
                          backgroundColor: pathMode ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.03)',
                          color: pathMode ? '#00E5FF' : 'rgba(255,255,255,0.5)',
                          border: `1px solid ${pathMode ? 'rgba(0,229,255,0.3)' : 'rgba(255,255,255,0.08)'}`,
                        }}>
                        {pathMode ? 'PICKING…' : 'PICK NODES'}
                      </button>
                    </div>
                    {pathMode && (
                      <p className="text-[7px] font-mono text-white/30 mb-1.5">
                        Click two nodes on the graph to trace their shortest connection.
                      </p>
                    )}
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-[8px] font-mono">
                        <span className="text-white/40 w-8">FROM</span>
                        <span className="text-[#FFD166] truncate">{pathSource ? (entityLabelById[pathSource] || pathSource) : '—'}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[8px] font-mono">
                        <span className="text-white/40 w-8">TO</span>
                        <span className="text-[#FFD166] truncate">{pathTarget ? (entityLabelById[pathTarget] || pathTarget) : '—'}</span>
                      </div>
                    </div>
                    {pathResult && (
                      <div className="mt-2 rounded border px-2 py-1.5"
                        style={{
                          borderColor: pathResult.reachable ? 'rgba(0,229,255,0.3)' : 'rgba(255,109,0,0.3)',
                          backgroundColor: pathResult.reachable ? 'rgba(0,229,255,0.05)' : 'rgba(255,109,0,0.05)',
                        }}>
                        {pathResult.reachable ? (
                          <>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-[8px] font-mono text-[#00E5FF] font-bold">{pathResult.hops} HOP{pathResult.hops === 1 ? '' : 'S'}</span>
                              <span className="text-[7px] font-mono text-white/40">cost {pathResult.cost.toFixed(2)}</span>
                            </div>
                            <div className="flex items-center flex-wrap gap-x-1 gap-y-0.5">
                              {pathResult.path.map((id, i) => (
                                <span key={id} className="flex items-center gap-1">
                                  <button onClick={() => handleSelectEntityById(id)}
                                    className="text-[7px] font-mono text-white/80 hover:text-[#00E5FF] truncate max-w-[80px]">
                                    {entityLabelById[id] || id}
                                  </button>
                                  {i < pathResult.path.length - 1 && <span className="text-white/30 text-[7px]">→</span>}
                                </span>
                              ))}
                            </div>
                          </>
                        ) : (
                          <span className="text-[8px] font-mono text-[#FF6D00]">No path — entities are not connected.</span>
                        )}
                      </div>
                    )}
                    {(pathSource || pathTarget) && (
                      <button onClick={clearPath} className="mt-1.5 text-[7px] font-mono text-white/40 hover:text-white">
                        CLEAR PATH
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SEARCH + FILTER BAR */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5 bg-black/20">
        <div className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded bg-black/40 border border-white/10">
          <Search className="w-3 h-3 text-white/40" />
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder="SEARCH ENTITIES..."
            className="flex-1 bg-transparent text-[9px] font-mono text-white outline-none placeholder:text-white/30" />
        </div>
        <div className="flex gap-1 overflow-x-auto styled-scrollbar">
          <button onClick={() => setActiveFilter('all')}
            className="px-1.5 py-1 rounded text-[7px] font-mono whitespace-nowrap transition-colors"
            style={{
              backgroundColor: activeFilter === 'all' ? 'rgba(255,255,255,0.1)' : 'transparent',
              color: activeFilter === 'all' ? '#fff' : 'rgba(255,255,255,0.4)',
            }}>ALL</button>
          {(Object.entries(PERSONAL_TYPE_COLORS) as [PersonalEntityType, string][]).map(([type, color]) => (
            <button key={type} onClick={() => setActiveFilter(activeFilter === type ? 'all' : type)}
              className="px-1.5 py-1 rounded text-[7px] font-mono whitespace-nowrap transition-colors"
              style={{
                backgroundColor: activeFilter === type ? `${color}20` : 'transparent',
                color: activeFilter === type ? color : 'rgba(255,255,255,0.4)',
                border: activeFilter === type ? `1px solid ${color}40` : '1px solid transparent',
              }}>{PERSONAL_TYPE_LABELS[type].toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* MAIN AREA: Graph */}
      <div ref={containerRef} className="flex-1 relative">
        {viewMode === 'editor' ? (
          <LinkEditorGraph
            entities={store.entities}
            relationships={store.relationships}
            onConnect={handleCreateRelationship}
            onDeleteRelationship={handleDeleteRelationship}
            onDeleteEntity={handleDeleteEntity}
            onMoveEntity={handleMoveEntity}
            onSelectEntity={handleSelectEntityById}
          />
        ) : displayGraph.nodes.length > 0 ? (
          <ForceGraph2D
            ref={graphRef}
            graphData={displayGraph}
            nodeId="id"
            nodeCanvasObject={paintNode}
            linkCanvasObject={paintLink}
            onNodeClick={handleNodeClick}
            backgroundColor="transparent"
            width={containerRef.current?.clientWidth || window.innerWidth}
            height={containerRef.current?.clientHeight || 400}
            d3AlphaDecay={0.04}
            d3VelocityDecay={0.3}
            cooldownTicks={150}
            linkDirectionalParticles={1}
            linkDirectionalParticleWidth={1.5}
            linkDirectionalParticleSpeed={0.004}
            linkDirectionalParticleColor={() => 'rgba(212,175,55,0.6)'}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Network className="w-10 h-10 mx-auto mb-3 text-white/10" />
              <p className="text-[11px] font-mono text-white/30 tracking-widest">NO ENTITY DATA</p>
              <p className="text-[9px] font-mono text-white/20 mt-1">Add entities to build the graph</p>
              <button onClick={() => setShowAddForm(true)}
                className="mt-3 px-3 py-1.5 rounded text-[9px] font-mono font-bold transition-colors"
                style={{ backgroundColor: 'rgba(212,175,55,0.15)', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.3)' }}>
                ADD FIRST ENTITY
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded bg-[#FF1744]/20 border border-[#FF1744]/30">
            <span className="text-[8px] font-mono text-[#FF1744]">{error}</span>
          </div>
        )}
      </div>

      {/* SELECTED NODE DETAILS */}
      <AnimatePresence>
        {selectedNode && (
          <motion.div
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            className="absolute bottom-0 left-0 right-0 border-t border-white/10 bg-black/90 backdrop-blur-md px-4 py-3 max-h-[200px] overflow-y-auto styled-scrollbar"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {(() => { const I = TYPE_ICONS[selectedNode.type] || Network; return <I className="w-4 h-4" style={{ color: PERSONAL_TYPE_COLORS[selectedNode.type] }} />; })()}
                  <span className="text-[13px] font-mono font-bold text-white">{selectedNode.label}</span>
                  <span className="text-[8px] font-mono px-1 py-0.5 rounded" style={{ backgroundColor: `${PERSONAL_TYPE_COLORS[selectedNode.type]}20`, color: PERSONAL_TYPE_COLORS[selectedNode.type], border: `1px solid ${PERSONAL_TYPE_COLORS[selectedNode.type]}40` }}>
                    {PERSONAL_TYPE_LABELS[selectedNode.type].toUpperCase()}
                  </span>
                  {selectedNode.coordinates && (
                    <button onClick={() => handleLocateNode(selectedNode)}
                      className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[7px] font-mono"
                      style={{ backgroundColor: 'rgba(0,229,255,0.15)', color: '#00E5FF' }}>
                      <Crosshair className="w-2 h-2" />
                      LOCATE
                    </button>
                  )}
                </div>
                {selectedNode.description && (
                  <p className="text-[9px] font-mono text-white/60 mt-1">{selectedNode.description}</p>
                )}
                {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                    {Object.entries(selectedNode.properties).map(([k, v]) => (
                      <div key={k} className="text-[8px] font-mono">
                        <span className="text-white/40 uppercase">{k.replace(/_/g, ' ')}: </span>
                        <span className="text-white/80">{typeof v === 'boolean' ? (v ? 'YES' : 'NO') : String(v || '—').slice(0, 60)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Connected entities */}
                {(() => {
                  const conns = graphData.links.filter(l =>
                    (typeof l.source === 'string' ? l.source : l.source.id) === selectedNode.id ||
                    (typeof l.target === 'string' ? l.target : l.target.id) === selectedNode.id
                  );
                  if (conns.length === 0) return null;
                  return (
                    <div className="mt-2">
                      <span className="text-[8px] font-mono text-white/40">CONNECTIONS ({conns.length})</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {conns.slice(0, 6).map((link, i) => {
                          const isSource = (typeof link.source === 'string' ? link.source : link.source.id) === selectedNode.id;
                          const otherId = isSource ? (typeof link.target === 'string' ? link.target : link.target.id) : (typeof link.source === 'string' ? link.source : link.source.id);
                          const other = graphData.nodes.find(n => n.id === otherId);
                          if (!other) return null;
                          return (
                            <button key={i} onClick={() => setSelectedNode(other)}
                              className="flex items-center gap-1 px-1 py-0.5 rounded text-[7px] font-mono cursor-pointer hover:bg-white/5 transition-colors"
                              style={{ backgroundColor: `${PERSONAL_TYPE_COLORS[other.type]}15`, border: `1px solid ${PERSONAL_TYPE_COLORS[other.type]}30` }}>
                              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: PERSONAL_TYPE_COLORS[other.type] }} />
                              <span style={{ color: PERSONAL_TYPE_COLORS[other.type] }}>{other.label}</span>
                              <span className="text-white/30">{link.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
              <div className="flex items-center gap-1 ml-2">
                <button onClick={() => handleDeleteEntity(selectedNode.id)}
                  className="p-1 text-white/30 hover:text-[#FF1744] transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* LEGEND */}
      {!selectedNode && (
        <div className="px-4 py-2 border-t border-white/5 flex items-center gap-3 flex-wrap bg-black/30">
          {(Object.entries(PERSONAL_TYPE_COLORS) as [PersonalEntityType, string][]).map(([t, c]) => (
            <div key={t} className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ background: c }} />
              <span className="text-[7px] font-mono text-white/40 uppercase">{PERSONAL_TYPE_LABELS[t]}</span>
            </div>
          ))}
        </div>
      )}

      {/* ADD ENTITY FORM (overlay) */}
      <AnimatePresence>
        {showAddForm && (
          <AddEntityForm
            onAdd={handleAddEntity}
            onClose={() => setShowAddForm(false)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── ADD ENTITY FORM ──
function AddEntityForm({ onAdd, onClose }: {
  onAdd: (entity: PersonalEntity) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<PersonalEntityType>('person');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [props, setProps] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  const addProp = () => {
    if (!newKey.trim()) return;
    setProps(p => ({ ...p, [newKey.trim()]: newVal }));
    setNewKey(''); setNewVal('');
  };

  const typeFields: Record<PersonalEntityType, { key: string; label: string }[]> = {
    person: [
      { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
      { key: 'dob', label: 'Date of Birth' }, { key: 'nationality', label: 'Nationality' },
      { key: 'occupation', label: 'Occupation' }, { key: 'aliases', label: 'Aliases' },
    ],
    phone_number: [
      { key: 'number', label: 'Number' }, { key: 'carrier', label: 'Carrier' },
      { key: 'country', label: 'Country Code' }, { key: 'contactName', label: 'Contact Name' },
    ],
    social_profile: [
      { key: 'platform', label: 'Platform (X/FB/IG)' }, { key: 'username', label: 'Username' },
      { key: 'url', label: 'Profile URL' }, { key: 'displayName', label: 'Display Name' },
      { key: 'email', label: 'Email' }, { key: 'followers', label: 'Followers Count' },
      { key: 'bio', label: 'Bio/Description' },
    ],
    personal_id: [
      { key: 'idType', label: 'Type (Passport/DL/ID)' }, { key: 'idNumber', label: 'ID Number' },
      { key: 'issuingCountry', label: 'Issuing Country' }, { key: 'fullName', label: 'Full Name on ID' },
      { key: 'expiryDate', label: 'Expiry Date' },
    ],
    vehicle: [
      { key: 'plate', label: 'License Plate' }, { key: 'vin', label: 'VIN' },
      { key: 'make', label: 'Make' }, { key: 'model', label: 'Model' },
      { key: 'year', label: 'Year' }, { key: 'color', label: 'Color' },
      { key: 'owner', label: 'Owner Name' },
    ],
    place: [
      { key: 'address', label: 'Address' }, { key: 'city', label: 'City' },
      { key: 'country', label: 'Country' }, { key: 'placeType', label: 'Type (Home/Work/Other)' },
      { key: 'residents', label: 'Residents (comma-sep)' },
    ],
    mac_address: [
      { key: 'mac', label: 'MAC Address' }, { key: 'vendor', label: 'Vendor/OUI' },
      { key: 'deviceName', label: 'Device Name' }, { key: 'owner', label: 'Owner' },
      { key: 'wifiNetworks', label: 'WiFi Networks (comma-sep)' },
    ],
    wifi_network: [
      { key: 'ssid', label: 'SSID' }, { key: 'bssid', label: 'BSSID' },
      { key: 'security', label: 'Security (WPA/WEP/Open)' }, { key: 'frequency', label: 'Frequency GHz' },
    ],
    event: [
      { key: 'eventType', label: 'Event Type' }, { key: 'date', label: 'Date' },
      { key: 'participants', label: 'Participants (comma-sep)' },
      { key: 'description', label: 'Description' },
    ],
    image_media: [
      { key: 'source', label: 'Source' }, { key: 'url', label: 'URL' },
      { key: 'faces', label: 'Faces Detected' }, { key: 'textExtracted', label: 'Text Extracted' },
    ],
  };

  const handleSubmit = () => {
    if (!label.trim()) return;
    const coords = lat && lng ? { lat: parseFloat(lat), lng: parseFloat(lng) } : undefined;
    const entity: PersonalEntity = {
      id: generateEntityId(type),
      type,
      domain: type === 'person' ? PersonalDomain.PERSON :
              type === 'phone_number' ? PersonalDomain.COMMUNICATION :
              type === 'social_profile' ? PersonalDomain.SOCIAL :
              type === 'personal_id' ? PersonalDomain.IDENTITY :
              type === 'vehicle' ? PersonalDomain.VEHICLE :
              type === 'place' ? PersonalDomain.LOCATION :
              type === 'mac_address' || type === 'wifi_network' ? PersonalDomain.NETWORK :
              type === 'event' ? PersonalDomain.EVENT : PersonalDomain.MEDIA,
      label: label.trim(),
      description: description.trim(),
      coordinates: coords,
      properties: { ...props },
      tags: [],
      source: 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    onAdd(entity);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, y: 20 }}
        className="w-[480px] max-h-[80vh] overflow-y-auto rounded-xl border border-white/10 bg-[#0a0a09] p-4 styled-scrollbar"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-[12px] font-mono font-bold text-[var(--gold-primary)] tracking-wider">ADD ENTITY</span>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        {/* Type selector */}
        <div className="flex flex-wrap gap-1 mb-3">
          {(Object.entries(PERSONAL_TYPE_COLORS) as [PersonalEntityType, string][]).map(([t, c]) => (
            <button key={t} onClick={() => { setType(t); setProps({}); }}
              className="px-2 py-1 rounded text-[8px] font-mono transition-colors"
              style={{
                backgroundColor: type === t ? `${c}20` : 'rgba(255,255,255,0.03)',
                color: type === t ? c : 'rgba(255,255,255,0.5)',
                border: `1px solid ${type === t ? `${c}40` : 'rgba(255,255,255,0.1)'}`,
              }}>
              {PERSONAL_TYPE_LABELS[t]}
            </button>
          ))}
        </div>

        <input value={label} onChange={e => setLabel(e.target.value)}
          placeholder={`${PERSONAL_TYPE_LABELS[type]} NAME / IDENTIFIER *`}
          className="w-full bg-black/40 text-[9px] font-mono text-white px-2 py-1.5 rounded outline-none border border-white/10 focus:border-[var(--gold-primary)] mb-1.5" />
        <textarea value={description} onChange={e => setDescription(e.target.value)}
          placeholder="DESCRIPTION (OPTIONAL)" rows={2}
          className="w-full bg-black/40 text-[8px] font-mono text-white/70 px-2 py-1.5 rounded outline-none border border-white/10 resize-none mb-1.5" />

        {/* Coordinates */}
        <div className="flex gap-1.5 mb-2">
          <input value={lat} onChange={e => setLat(e.target.value)} placeholder="LAT (opt)" type="number" step="any"
            className="w-1/2 bg-black/40 text-[8px] font-mono text-white/70 px-2 py-1 rounded outline-none border border-white/10" />
          <input value={lng} onChange={e => setLng(e.target.value)} placeholder="LNG (opt)" type="number" step="any"
            className="w-1/2 bg-black/40 text-[8px] font-mono text-white/70 px-2 py-1 rounded outline-none border border-white/10" />
        </div>

        {/* Type-specific fields */}
        <div className="grid grid-cols-2 gap-1.5 mb-2">
          {typeFields[type].map(f => (
            <input key={f.key} value={props[f.key] || ''} onChange={e => setProps(p => ({ ...p, [f.key]: e.target.value }))}
              placeholder={f.label}
              className="bg-black/40 text-[8px] font-mono text-white/70 px-2 py-1 rounded outline-none border border-white/10" />
          ))}
        </div>

        {/* Custom properties */}
        <div className="flex gap-1 mb-2">
          <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="CUSTOM KEY"
            className="flex-1 bg-black/40 text-[8px] font-mono text-white/70 px-2 py-1 rounded outline-none border border-white/10"
            onKeyDown={e => e.key === 'Enter' && addProp()} />
          <input value={newVal} onChange={e => setNewVal(e.target.value)} placeholder="VALUE"
            className="flex-1 bg-black/40 text-[8px] font-mono text-white/70 px-2 py-1 rounded outline-none border border-white/10"
            onKeyDown={e => e.key === 'Enter' && addProp()} />
          <button onClick={addProp} className="px-2 py-1 rounded text-[8px] font-mono text-[var(--cyan-primary)] bg-[var(--cyan-primary)]/10 border border-[var(--cyan-primary)]/20">
            ADD
          </button>
        </div>
        {Object.entries(props).filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="flex items-center gap-1 px-1.5 py-0.5 rounded mb-0.5 text-[7px] font-mono" style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}>
            <span className="text-white/60">{k}:</span>
            <span className="text-white/80">{String(v).slice(0, 40)}</span>
            <button onClick={() => setProps(p => { const n = { ...p }; delete n[k]; return n; })} className="ml-auto text-white/30 hover:text-[#FF1744]">
              <X className="w-2 h-2" />
            </button>
          </div>
        ))}

        <button onClick={handleSubmit} disabled={!label.trim()}
          className="w-full py-2 rounded text-[9px] font-mono font-bold transition-colors disabled:opacity-30 mt-2"
          style={{ backgroundColor: 'rgba(212,175,55,0.15)', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.3)' }}>
          ADD TO GRAPH
        </button>
      </motion.div>
    </motion.div>
  );
}

export default memo(PersonalGraphPanelInner);
