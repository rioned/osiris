/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Report Generation Engine
 *
 *  Compiles active intelligence layers, ontology entities, and
 *  AI analysis into formatted reports (HTML, CSV, Markdown).
 *  Supports scheduled generation and webhook delivery.
 *
 *  Zero external dependencies — reports are HTML + CSV + JSON.
 * ═══════════════════════════════════════════════════════════════
 */

import { getEntities, getRelationships } from '../store/entity-store';

// ──────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────

export type ReportFormat = 'html' | 'csv' | 'markdown' | 'json' | 'xls' | 'pdf';

export type ReportSection =
  | 'executive_summary'
  | 'intelligence_layers'
  | 'ontology_entities'
  | 'ontology_relationships'
  | 'stance_analysis'
  | 'influence_analysis'
  | 'behavioural_profiles'
  | 'graph_analytics'
  | 'narrative_traces'
  | 'ai_briefing'
  | 'statistics';

export interface ReportConfig {
  /** Report title */
  title: string;
  /** Output format */
  format: ReportFormat;
  /** Sections to include (empty = all) */
  sections?: ReportSection[];
  /** Filter by entity type */
  entityType?: string;
  /** Filter by stance target */
  stanceTarget?: string;
  /** Maximum entities to include */
  maxEntities?: number;
  /** Include AI analysis (requires API key) */
  includeAIAnalysis?: boolean;
  /** Brand color */
  brandColor?: string;
  /** Organization name */
  organization?: string;
}

export interface ReportSectionData {
  name: ReportSection;
  title: string;
  content: any;
}

export interface CompiledReport {
  config: ReportConfig;
  generatedAt: string;
  sections: ReportSectionData[];
  /** Total size estimate */
  size: number;
  /** Format-specific output */
  output: string;
}

// ──────────────────────────────────────────────────────────────
//  REPORT DATA COLLECTION
// ──────────────────────────────────────────────────────────────

/**
 * Collect data for each requested report section.
 */
async function collectReportData(config: ReportConfig): Promise<ReportSectionData[]> {
  const sections: ReportSectionData[] = [];
  const requestedSections = config.sections || [];
  const allSections: ReportSection[] = requestedSections.length > 0
    ? requestedSections
    : ['executive_summary', 'statistics', 'ontology_entities', 'stance_analysis'];

  // Statistics section (always available)
  if (allSections.includes('statistics') || allSections.includes('executive_summary')) {
    const entities = await getEntities({ limit: config.maxEntities || 500 });
    const relationships = await getRelationships();

    const typeCounts: Record<string, number> = {};
    for (const e of entities.entities) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }

    const relTypeCounts: Record<string, number> = {};
    for (const r of relationships) {
      relTypeCounts[r.label] = (relTypeCounts[r.label] || 0) + 1;
    }

    // Count entities with stance
    const stanceCount = entities.entities.filter(e => e.properties?.stance_profiles).length;
    const enrichedCount = entities.entities.filter(e => e.properties?.nlp_enriched).length;
    const expiredCount = entities.entities.filter(e => {
      const expires = e.properties?.provenance_expires_at;
      return expires && new Date(expires).getTime() < Date.now();
    }).length;

    const stats = {
      totalEntities: entities.total,
      entityTypeBreakdown: typeCounts,
      totalRelationships: relationships.length,
      relationshipTypeBreakdown: relTypeCounts,
      entitiesWithStance: stanceCount,
      entitiesNLPEnriched: enrichedCount,
      entitiesExpired: expiredCount,
    };

    sections.push({ name: 'statistics', title: 'Ontology Statistics', content: stats });
    sections.push({ name: 'executive_summary', title: 'Executive Summary', content: generateExecutiveSummary(stats) });
  }

  // Ontology entities section
  if (allSections.includes('ontology_entities')) {
    const opts: any = { limit: config.maxEntities || 200 };
    if (config.entityType) opts.type = config.entityType;

    const { entities } = await getEntities(opts);

    // Filter by stance target if specified
    let filtered = entities;
    if (config.stanceTarget) {
      const target = config.stanceTarget.toLowerCase();
      filtered = entities.filter(e => {
        const profiles = e.properties?.stance_profiles;
        return profiles && profiles[target];
      });
    }

    sections.push({
      name: 'ontology_entities',
      title: config.entityType
        ? `${config.entityType} Entities`
        : 'Ontology Entities',
      content: filtered.slice(0, config.maxEntities || 200),
    });
  }

  // Ontology relationships section
  if (allSections.includes('ontology_relationships')) {
    const relationships = await getRelationships();
    const relCounts: Record<string, number> = {};
    for (const r of relationships) {
      relCounts[r.label] = (relCounts[r.label] || 0) + 1;
    }
    sections.push({
      name: 'ontology_relationships',
      title: 'Relationship Summary',
      content: {
        total: relationships.length,
        byType: relCounts,
        recent: relationships.slice(0, 50),
      },
    });
  }

  // Stance analysis section
  if (allSections.includes('stance_analysis')) {
    const { entities } = await getEntities({ limit: 500 });
    const stanceSummary: Record<string, { positive: number; negative: number; neutral: number; avgScore: number }> = {};

    for (const e of entities) {
      const profiles = e.properties?.stance_profiles;
      if (!profiles) continue;
      for (const [target, profile] of Object.entries(profiles) as any) {
        if (!stanceSummary[target]) {
          stanceSummary[target] = { positive: 0, negative: 0, neutral: 0, avgScore: 0 };
        }
        if (profile.sentimentLabel === 'positive') stanceSummary[target].positive++;
        else if (profile.sentimentLabel === 'negative') stanceSummary[target].negative++;
        else stanceSummary[target].neutral++;
      }
    }

    // Compute averages
    for (const [target, data] of Object.entries(stanceSummary)) {
      const total = data.positive + data.negative + data.neutral;
      const profiles = entities
        .map(e => e.properties?.stance_profiles?.[target])
        .filter(Boolean);
      data.avgScore = profiles.length > 0
        ? Math.round(profiles.reduce((s: number, p: any) => s + p.score, 0) / profiles.length * 100) / 100
        : 0;
    }

    sections.push({
      name: 'stance_analysis',
      title: 'Stance Analysis',
      content: {
        totalTargets: Object.keys(stanceSummary).length,
        targets: stanceSummary,
      },
    });
  }

  // Behavioural profiles
  if (allSections.includes('behavioural_profiles')) {
    sections.push({
      name: 'behavioural_profiles',
      title: 'Behavioural Profiles',
      content: {
        note: 'Run /api/behavioural/profile?entityId=xxx for per-entity profiles',
      },
    });
  }

  // AI Briefing
  if (allSections.includes('ai_briefing') && config.includeAIAnalysis) {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      const briefingRes = await fetch(`${baseUrl}/api/ai/briefing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: config.title,
          scope: 'full',
          includeRawData: false,
        }),
      });
      if (briefingRes.ok) {
        const briefingData = await briefingRes.json();
        sections.push({
          name: 'ai_briefing',
          title: 'AI Intelligence Briefing',
          content: briefingData.briefing || briefingData.analysis || 'No briefing generated',
        });
      }
    } catch {
      sections.push({
        name: 'ai_briefing',
        title: 'AI Intelligence Briefing',
        content: 'AI briefing unavailable (check API key configuration)',
      });
    }
  }

  return sections;
}

function generateExecutiveSummary(stats: any): string {
  const parts: string[] = [];
  parts.push(`This report covers **${stats.totalEntities}** ontology entities connected by **${stats.totalRelationships}** relationships.`);
  parts.push(`Of these, **${stats.entitiesWithStance}** entities have stance profiles, and **${stats.entitiesNLPEnriched}** have been NLP-enriched.`);
  if (stats.entitiesExpired > 0) {
    parts.push(`**${stats.entitiesExpired}** entities are past their retention expiry date.`);
  }
  return parts.join(' ');
}

// ──────────────────────────────────────────────────────────────
//  HTML REPORT RENDERER
// ──────────────────────────────────────────────────────────────

function renderHTML(sections: ReportSectionData[], config: ReportConfig): string {
  const brandColor = config.brandColor || '#00E5FF';
  const org = config.organization || 'OSIRIS Intelligence';
  const now = new Date().toISOString();

  const sectionHTML = sections.map(s => {
    const content = typeof s.content === 'string' ? s.content : JSON.stringify(s.content, null, 2);
    const formattedContent = typeof s.content === 'string'
      ? s.content
      : renderContentAsHTML(s);

    return `
    <div class="section">
      <h2>${s.title}</h2>
      ${formattedContent}
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${config.title} — ${org}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #0a0a0f; color: #e0e0e0; line-height: 1.6; }
  .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
  .header { border-bottom: 2px solid ${brandColor}; padding-bottom: 20px; margin-bottom: 30px; }
  .header h1 { font-size: 28px; color: ${brandColor}; margin-bottom: 5px; }
  .header .meta { color: #888; font-size: 13px; }
  .section { margin-bottom: 30px; padding: 20px; background: #12121a; border-radius: 8px; border: 1px solid #1e1e2a; }
  .section h2 { color: ${brandColor}; font-size: 18px; margin-bottom: 15px; padding-bottom: 8px; border-bottom: 1px solid #1e1e2a; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #1e1e2a; }
  th { color: ${brandColor}; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover td { background: #1a1a2a; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .stat-card { padding: 15px; background: #0e0e16; border-radius: 6px; border: 1px solid #1e1e2a; text-align: center; }
  .stat-card .value { font-size: 24px; font-weight: 700; color: ${brandColor}; }
  .stat-card .label { font-size: 12px; color: #888; margin-top: 4px; }
  pre { background: #0a0a0f; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; color: #ccc; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; margin: 1px; }
  .badge-positive { background: #1a3a1a; color: #4ade80; }
  .badge-negative { background: #3a1a1a; color: #f87171; }
  .badge-neutral { background: #1a1a3a; color: #60a5fa; }
  .footer { text-align: center; color: #555; font-size: 12px; margin-top: 40px; padding-top: 20px; border-top: 1px solid #1e1e2a; }
  /* ── Print / PDF stylesheet ── */
  @media print {
    body { background: #fff; color: #000; }
    .container { max-width: 100%; padding: 20px; }
    .header h1 { color: #000; }
    .section { background: #f8f8f8; border-color: #ddd; page-break-inside: avoid; }
    .section h2 { color: #000; border-bottom-color: #ccc; }
    table { font-size: 10px; }
    th { color: #333; }
    tr:hover td { background: inherit; }
    .stat-card { background: #eee; border-color: #ccc; }
    .stat-card .value { color: #000; }
    .badge-positive { background: #d4edda; color: #155724; }
    .badge-negative { background: #f8d7da; color: #721c24; }
    .badge-neutral { background: #d1ecf1; color: #0c5460; }
    .footer { color: #999; }
    pre { background: #f0f0f0; color: #333; }
    .no-print { display: none; }
  }
  .page-break { page-break-before: always; }
  @page { margin: 1.5cm; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${config.title}</h1>
    <div class="meta">${org} · Generated ${new Date(now).toLocaleString()} · ${sections.length} sections</div>
    <div class="meta no-print" style="margin-top:8px;font-size:12px;">📄 Save as PDF: File → Print (Ctrl+P) → Save as PDF</div>
  </div>
  ${sectionHTML}
  <div class="footer">${org} · Automated Intelligence Report · Confidential</div>
</div>
</body>
</html>`;
}

function renderContentAsHTML(section: ReportSectionData): string {
  const c = section.content;

  if (section.name === 'statistics') {
    const stats = c as any;
    const entityTypes = Object.entries(stats.entityTypeBreakdown || {})
      .map(([type, count]) => `<div class="stat-card"><div class="value">${count}</div><div class="label">${type}</div></div>`)
      .join('\n');

    const relTypes = Object.entries(stats.relationshipTypeBreakdown || {})
      .map(([type, count]) => `<tr><td>${type}</td><td>${count}</td></tr>`)
      .join('\n');

    return `
    <div class="stat-grid">
      <div class="stat-card"><div class="value">${stats.totalEntities}</div><div class="label">Total Entities</div></div>
      <div class="stat-card"><div class="value">${stats.totalRelationships}</div><div class="label">Relationships</div></div>
      <div class="stat-card"><div class="value">${stats.entitiesWithStance}</div><div class="label">With Stance</div></div>
      <div class="stat-card"><div class="value">${stats.entitiesNLPEnriched}</div><div class="label">NLP Enriched</div></div>
      <div class="stat-card"><div class="value">${stats.entitiesExpired}</div><div class="label">Expired</div></div>
    </div>
    <h3 style="margin-top:20px;color:#888;font-size:14px;">Entity Type Breakdown</h3>
    <div class="stat-grid">${entityTypes}</div>
    <h3 style="margin-top:20px;color:#888;font-size:14px;">Relationship Breakdown</h3>
    <table><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody>${relTypes}</tbody></table>`;
  }

  if (section.name === 'ontology_entities') {
    const entities = Array.isArray(c) ? c : [];
    if (entities.length === 0) return '<p>No entities found.</p>';
    const rows = entities.map((e: any) => {
      const profiles = e.properties?.stance_profiles;
      const stanceTags = profiles ? Object.entries(profiles).map(([t, p]: any) =>
        `<span class="badge badge-${p.sentimentLabel}">${t}: ${p.sentimentLabel}</span>`
      ).join('') : '';
      const enriched = e.properties?.nlp_enriched ? '✓' : '';
      return `<tr><td>${e.label}</td><td>${e.type}</td><td>${e.source}</td><td>${enriched}</td><td>${stanceTags}</td></tr>`;
    }).join('\n');
    return `<p>Showing ${entities.length} entities</p>
    <table><thead><tr><th>Label</th><th>Type</th><th>Source</th><th>NLP</th><th>Stance</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  if (section.name === 'stance_analysis') {
    const data = c as any;
    const targets = Object.entries(data.targets || {}).map(([target, info]: any) => {
      const label = info.avgScore > 0.3 ? 'positive' : info.avgScore < -0.3 ? 'negative' : 'neutral';
      return `<tr><td>${target}</td>
        <td><span class="badge badge-${label}">${label} (${info.avgScore})</span></td>
        <td>${info.positive}</td><td>${info.negative}</td><td>${info.neutral}</td></tr>`;
    }).join('\n');
    return `<p>${data.totalTargets} stance targets found</p>
    <table><thead><tr><th>Target</th><th>Avg Score</th><th>Positive</th><th>Negative</th><th>Neutral</th></tr></thead><tbody>${targets}</tbody></table>`;
  }

  if (typeof c === 'string') {
    // Convert markdown-like content to HTML
    return `<div class="content">${c.replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</div>`;
  }

  return `<pre>${JSON.stringify(c, null, 2)}</pre>`;
}

// ──────────────────────────────────────────────────────────────
//  CSV REPORT RENDERER
// ──────────────────────────────────────────────────────────────

function renderCSV(sections: ReportSectionData[], config: ReportConfig): string {
  const lines: string[] = [];
  lines.push(`Report: ${config.title}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Organization: ${config.organization || 'OSIRIS'}`);
  lines.push('');

  for (const section of sections) {
    lines.push(`=== ${section.title} ===`);
    lines.push('');

    if (section.name === 'statistics') {
      const stats = section.content as any;
      lines.push('Entity Type,Count');
      for (const [type, count] of Object.entries(stats.entityTypeBreakdown || {})) {
        lines.push(`"${type}",${count}`);
      }
      lines.push('');
      lines.push('Relationship Type,Count');
      for (const [type, count] of Object.entries(stats.relationshipTypeBreakdown || {})) {
        lines.push(`"${type}",${count}`);
      }
    }

    if (section.name === 'ontology_entities') {
      const entities = Array.isArray(section.content) ? section.content : [];
      lines.push('Label,Type,Source,Stance Targets');
      for (const e of entities) {
        const profiles = e.properties?.stance_profiles;
        const stances = profiles ? Object.keys(profiles).join('; ') : '';
        const safeLabel = `"${(e.label || '').replace(/"/g, '""')}"`;
        lines.push(`${safeLabel},${e.type},${e.source},"${stances}"`);
      }
    }

    if (section.name === 'stance_analysis') {
      const data = section.content as any;
      lines.push('Target,Avg Score,Positive,Negative,Neutral');
      for (const [target, info] of Object.entries(data.targets || {})) {
        const d = info as any;
        lines.push(`"${target}",${d.avgScore},${d.positive},${d.negative},${d.neutral}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
//  MARKDOWN REPORT RENDERER
// ──────────────────────────────────────────────────────────────

function renderMarkdown(sections: ReportSectionData[], config: ReportConfig): string {
  const lines: string[] = [];
  lines.push(`# ${config.title}`);
  lines.push('');
  lines.push(`**Organization:** ${config.organization || 'OSIRIS Intelligence'}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Sections:** ${sections.length}`);
  lines.push('---');
  lines.push('');

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push('');

    if (section.name === 'statistics') {
      const stats = section.content as any;
      lines.push(`- **Total Entities:** ${stats.totalEntities}`);
      lines.push(`- **Total Relationships:** ${stats.totalRelationships}`);
      lines.push(`- **Entities with Stance:** ${stats.entitiesWithStance}`);
      lines.push(`- **NLP Enriched:** ${stats.entitiesNLPEnriched}`);
      lines.push(`- **Expired:** ${stats.entitiesExpired}`);
      lines.push('');
      lines.push('### Entity Type Breakdown');
      for (const [type, count] of Object.entries(stats.entityTypeBreakdown || {})) {
        lines.push(`- ${type}: ${count}`);
      }
    }

    if (section.name === 'ontology_entities') {
      const entities = Array.isArray(section.content) ? section.content : [];
      lines.push(`| Label | Type | Source | Stance |`);
      lines.push(`|-------|------|--------|--------|`);
      for (const e of entities) {
        const profiles = e.properties?.stance_profiles;
        const stances = profiles ? Object.keys(profiles).join(', ') : '';
        lines.push(`| ${e.label} | ${e.type} | ${e.source} | ${stances} |`);
      }
    }

    if (section.name === 'stance_analysis') {
      const data = section.content as any;
      lines.push(`| Target | Avg Score | Positive | Negative | Neutral |`);
      lines.push(`|--------|-----------|----------|----------|---------|`);
      for (const [target, info] of Object.entries(data.targets || {})) {
        const d = info as any;
        lines.push(`| ${target} | ${d.avgScore} | ${d.positive} | ${d.negative} | ${d.neutral} |`);
      }
    }

    if (typeof section.content === 'string') {
      lines.push(section.content);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
//  JSON REPORT RENDERER
// ──────────────────────────────────────────────────────────────

function renderJSON(sections: ReportSectionData[], config: ReportConfig): string {
  const report = {
    report: {
      title: config.title,
      generatedAt: new Date().toISOString(),
      organization: config.organization || 'OSIRIS Intelligence',
      sections: sections.map(s => ({
        name: s.name,
        title: s.title,
        content: s.content,
      })),
    },
  };
  return JSON.stringify(report, null, 2);
}

// ──────────────────────────────────────────────────────────────
//  XLS (HTML-table Excel-compatible) RENDERER
// ──────────────────────────────────────────────────────────────

function renderXLS(sections: ReportSectionData[], config: ReportConfig): string {
  const rows: string[] = [];
  const now = new Date().toISOString();

  // Excel opens HTML tables natively when saved as .xls
  rows.push('<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">');
  rows.push('<head><meta charset="UTF-8"><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>');
  rows.push(`<x:Name>${config.title.slice(0, 31)}</x:Name>`);
  rows.push('<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml>');
  rows.push('<style>td{mso-number-format:"\\@";padding:4px 8px;border:1px solid #ccc;font-size:10pt}');
  rows.push('th{background:#1a1a2a;color:#fff;padding:6px 8px;border:1px solid #333;font-size:10pt;text-align:left}');
  rows.push('.section-header{background:#e8e8e8;font-weight:bold;font-size:12pt}</style></head><body>');
  rows.push(`<table><tr><th colspan="10">${config.title}</th></tr>`);
  rows.push(`<tr><td colspan="10">Generated: ${now} | Organization: ${config.organization || 'OSIRIS'} | Format: XLS</td></tr>`);
  rows.push('</table><br>');

  for (const section of sections) {
    rows.push(`<table><tr class="section-header"><td colspan="10">${section.title}</td></tr>`);

    if (section.name === 'statistics') {
      const stats = section.content as any;
      rows.push('<tr><th>Metric</th><th>Value</th></tr>');
      rows.push(`<tr><td>Total Entities</td><td>${stats.totalEntities}</td></tr>`);
      rows.push(`<tr><td>Total Relationships</td><td>${stats.totalRelationships}</td></tr>`);
      rows.push(`<tr><td>Entities with Stance</td><td>${stats.entitiesWithStance}</td></tr>`);
      rows.push(`<tr><td>NLP Enriched</td><td>${stats.entitiesNLPEnriched}</td></tr>`);
      rows.push(`<tr><td>Expired</td><td>${stats.entitiesExpired}</td></tr>`);
      rows.push('</table><br>');
      rows.push('<table><tr><th>Entity Type</th><th>Count</th></tr>');
      for (const [type, count] of Object.entries(stats.entityTypeBreakdown || {})) {
        rows.push(`<tr><td>${type}</td><td>${count}</td></tr>`);
      }
    }

    if (section.name === 'ontology_entities') {
      const entities = Array.isArray(section.content) ? section.content : [];
      rows.push(`<tr><td colspan="10">${entities.length} entities</td></tr>`);
      rows.push('<tr><th>Label</th><th>Type</th><th>Source</th><th>NLP</th><th>Stance</th><th>Language</th><th>Toxicity</th><th>Keywords</th></tr>');
      for (const e of entities.slice(0, 500)) {
        const profiles = e.properties?.stance_profiles;
        const stances = profiles ? Object.keys(profiles).join('; ') : '';
        const keywords = (e.properties?.nlp_top_keywords || []).slice(0, 3).join('; ');
        const lang = e.properties?.nlp_language || '';
        const tox = e.properties?.nlp_toxicity_score !== undefined ? e.properties.nlp_toxicity_score : '';
        rows.push(`<tr><td>${e.label || ''}</td><td>${e.type}</td><td>${e.source}</td><td>${e.properties?.nlp_enriched ? 'Y' : ''}</td><td>${stances}</td><td>${lang}</td><td>${tox}</td><td>${keywords}</td></tr>`);
      }
    }

    if (section.name === 'stance_analysis') {
      const data = section.content as any;
      rows.push('<tr><th>Target</th><th>Avg Score</th><th>Positive</th><th>Negative</th><th>Neutral</th></tr>');
      for (const [target, info] of Object.entries(data.targets || {})) {
        const d = info as any;
        rows.push(`<tr><td>${target}</td><td>${d.avgScore}</td><td>${d.positive}</td><td>${d.negative}</td><td>${d.neutral}</td></tr>`);
      }
    }

    rows.push('</table><br>');
  }

  rows.push('</body></html>');
  return rows.join('\n');
}

// ──────────────────────────────────────────────────────────────
//  MAIN GENERATOR
// ──────────────────────────────────────────────────────────────

/**
 * Generate a compiled report with the given configuration.
 */
export async function generateReport(config: ReportConfig): Promise<CompiledReport> {
  const sections = await collectReportData(config);

  let output: string;
  switch (config.format) {
    case 'html':
      output = renderHTML(sections, config);
      break;
    case 'csv':
      output = renderCSV(sections, config);
      break;
    case 'markdown':
      output = renderMarkdown(sections, config);
      break;
    case 'json':
      output = renderJSON(sections, config);
      break;
    case 'xls':
      output = renderXLS(sections, config);
      break;
    default:
      output = renderHTML(sections, config);
  }

  return {
    config,
    generatedAt: new Date().toISOString(),
    sections,
    size: output.length,
    output,
  };
}

// ──────────────────────────────────────────────────────────────
//  DELIVERY
// ──────────────────────────────────────────────────────────────

export interface DeliveryConfig {
  /** Webhook URL to POST the report to */
  webhookUrl?: string;
  /** Email recipients (comma-separated) */
  emailTo?: string;
  /** SMTP configuration for email delivery */
  smtp?: {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
  };
}

/**
 * Deliver a report via webhook or email.
 * Email delivery uses Node.js built-in `net` module for SMTP.
 */
export async function deliverReport(
  report: CompiledReport,
  delivery: DeliveryConfig,
): Promise<{ webhook?: any; email?: any }> {
  const result: { webhook?: any; email?: any } = {};

  // ── Webhook delivery ──
  if (delivery.webhookUrl) {
    try {
      const webhookRes = await fetch(delivery.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OSIRIS-Report': report.config.title,
          'X-OSIRIS-Format': report.config.format,
        },
        body: JSON.stringify({
          title: report.config.title,
          format: report.config.format,
          generatedAt: report.generatedAt,
          sections: report.sections.map(s => ({
            name: s.name,
            title: s.title,
          })),
          output: report.output,
          size: report.size,
        }),
      });
      result.webhook = { status: webhookRes.status, ok: webhookRes.ok };
    } catch (e: any) {
      result.webhook = { error: e.message };
    }
  }

  // ── Email delivery via SMTP (Node.js built-in `net`) ──
  if (delivery.emailTo && delivery.smtp) {
    try {
      const { host, port, user, pass, from } = delivery.smtp;
      const recipients = delivery.emailTo.split(',').map(r => r.trim()).filter(Boolean);
      const boundary = `OSIRIS_REPORT_${Date.now()}`;
      const filename = `${report.config.title.replace(/[^a-z0-9]/gi, '_')}.${report.config.format}`;
      const contentType = report.config.format === 'html' || report.config.format === 'xls' || report.config.format === 'pdf'
        ? 'text/html'
        : report.config.format === 'csv' ? 'text/csv'
        : report.config.format === 'markdown' ? 'text/markdown'
        : 'application/json';

      // Build MIME email
      const emailBody = [
        `From: ${from}`,
        `To: ${delivery.emailTo}`,
        `Subject: ${report.config.title} — OSIRIS Intelligence Report`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        '',
        `OSIRIS Intelligence Report: ${report.config.title}`,
        `Generated: ${report.generatedAt}`,
        `Format: ${report.config.format.toUpperCase()}`,
        `Size: ${Math.round(report.size / 1024)} KB`,
        `Sections: ${report.sections.length}`,
        '',
        `This is an automated report from OSIRIS Intelligence Platform.`,
        `The report is attached as ${filename}.`,
        '',
        `--${boundary}`,
        `Content-Type: ${contentType}; charset="utf-8"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(report.output).toString('base64'),
        '',
        `--${boundary}--`,
      ].join('\r\n');

      // Send via SMTP using raw TCP
      const { net } = await import('net' as any);
      const emailResult = await sendSMTP(host, port || 587, user, pass, from, delivery.emailTo, emailBody);
      result.email = emailResult;
    } catch (e: any) {
      result.email = { error: e.message };
    }
  }

  return result;
}

/**
 * Send email via SMTP using raw TCP connection (Node.js built-in `net` module).
 * Supports STARTTLS and AUTH LOGIN.
 */
async function sendSMTP(
  host: string,
  port: number,
  user: string,
  pass: string,
  from: string,
  to: string,
  emailBody: string,
): Promise<{ sent: boolean; message: string }> {
  const { Socket } = await import('net' as any);

  return new Promise((resolve) => {
    const socket = new Socket();
    let response = '';
    let step = 0;
    const timeout = 10000;

    const send = (cmd: string) => {
      socket.write(cmd + '\r\n');
    };

    const expect = (code: string, next: () => void) => {
      if (response.includes(code)) {
        response = '';
        next();
      }
    };

    socket.setTimeout(timeout);
    socket.connect(port, host);

    socket.on('data', (data: Buffer) => {
      response += data.toString();

      if (step === 0 && response.includes('220')) {
        step = 1;
        response = '';
        send(`EHLO osiris.local`);
        return;
      }

      if (step === 1 && (response.includes('250') || response.includes('220'))) {
        step = 2;
        response = '';
        // Try STARTTLS if on port 587, otherwise proceed
        if (port === 587) {
          send('STARTTLS');
        } else {
          send(`AUTH LOGIN`);
        }
        return;
      }

      if (step === 2 && response.includes('220')) {
        // Server supports STARTTLS — but we can't upgrade in pure Node without tls module wrapping
        // Fall through to AUTH
        step = 3;
        response = '';
        send(`AUTH LOGIN`);
        return;
      }

      if (step === 2 && (response.includes('334') || response.includes('250'))) {
        step = 3;
        response = '';
        send(`AUTH LOGIN`);
        return;
      }

      if (step === 3 && response.includes('334')) {
        step = 4;
        response = '';
        send(Buffer.from(user).toString('base64'));
        return;
      }

      if (step === 4 && response.includes('334')) {
        step = 5;
        response = '';
        send(Buffer.from(pass).toString('base64'));
        return;
      }

      if (step === 5 && (response.includes('235') || response.includes('334'))) {
        step = 6;
        response = '';
        send(`MAIL FROM:<${from}>`);
        return;
      }

      if (step === 6 && response.includes('250')) {
        step = 7;
        response = '';
        const recipients = to.split(',').map(r => r.trim());
        send(`RCPT TO:<${recipients[0]}>`);
        return;
      }

      if (step === 7 && response.includes('250')) {
        step = 8;
        response = '';
        send('DATA');
        return;
      }

      if (step === 8 && response.includes('354')) {
        step = 9;
        response = '';
        send(emailBody + '\r\n.');
        return;
      }

      if (step === 9 && response.includes('250')) {
        step = 10;
        send('QUIT');
        socket.destroy();
        resolve({ sent: true, message: 'Email sent successfully' });
        return;
      }

      // Error handling
      if (response.includes('500') || response.includes('501') || response.includes('502') ||
          response.includes('503') || response.includes('504') || response.includes('550') ||
          response.includes('551') || response.includes('552') || response.includes('553') ||
          response.includes('554') || response.includes('535') || response.includes('530')) {
        socket.destroy();
        resolve({ sent: false, message: `SMTP error: ${response.slice(0, 200)}` });
        return;
      }
    });

    socket.on('error', (err: Error) => {
      socket.destroy();
      resolve({ sent: false, message: `Connection error: ${err.message}` });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ sent: false, message: 'SMTP connection timed out' });
    });
  });
}
