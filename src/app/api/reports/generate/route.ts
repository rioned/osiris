/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Report Generation API
 *
 *  POST /api/reports/generate
 *    Generate a report with the given configuration.
 *    Body: ReportConfig
 *    Returns: CompiledReport (includes format-specific output)
 *
 *  POST /api/reports/deliver
 *    Generate and deliver a report via webhook.
 *    Body: { config: ReportConfig, delivery: DeliveryConfig }
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { generateReport, deliverReport, type ReportConfig, type DeliveryConfig } from '@/lib/reporting/generator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || 'generate';

    switch (action) {
      case 'generate': {
        const config: ReportConfig = {
          title: body.title || 'OSIRIS Intelligence Report',
          format: body.format || 'html',
          sections: body.sections,
          entityType: body.entityType,
          stanceTarget: body.stanceTarget,
          maxEntities: body.maxEntities || 200,
          includeAIAnalysis: body.includeAIAnalysis !== false,
          brandColor: body.brandColor || '#00E5FF',
          organization: body.organization || 'OSIRIS Intelligence',
        };

        const report = await generateReport(config);
        const sizeKB = Math.round(report.size / 1024);

        return NextResponse.json({
          success: true,
          title: report.config.title,
          format: report.config.format,
          generatedAt: report.generatedAt,
          sections: report.sections.map(s => ({ name: s.name, title: s.title })),
          sizeKB,
          output: report.output,
        });
      }

      case 'preview': {
        // Quick preview: stats-only HTML report
        const config: ReportConfig = {
          title: body.title || 'OSIRIS Preview',
          format: 'html',
          sections: ['executive_summary', 'statistics'],
          maxEntities: 50,
          includeAIAnalysis: false,
          brandColor: body.brandColor || '#00E5FF',
          organization: body.organization || 'OSIRIS',
        };

        const report = await generateReport(config);
        return NextResponse.json({
          success: true,
          title: report.config.title,
          format: 'html',
          generatedAt: report.generatedAt,
          sizeKB: Math.round(report.size / 1024),
          output: report.output,
        });
      }

      case 'deliver': {
        const config: ReportConfig = body.config || {
          title: 'OSIRIS Intelligence Report',
          format: 'json',
          sections: ['executive_summary', 'statistics', 'ontology_entities'],
        };

        const delivery: DeliveryConfig = body.delivery || {};
        if (!delivery.webhookUrl && !delivery.emailTo) {
          return NextResponse.json({ error: 'At least one of webhookUrl or emailTo required' }, { status: 400 });
        }

        const report = await generateReport(config);
        const deliveryResult = await deliverReport(report, delivery);

        return NextResponse.json({
          success: true,
          title: report.config.title,
          format: report.config.format,
          sections: report.sections.length,
          sizeKB: Math.round(report.size / 1024),
          delivery: deliveryResult,
        });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[Reports] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const format = searchParams.get('format') || 'html';
    const entityType = searchParams.get('type') || undefined;
    const stanceTarget = searchParams.get('stance') || undefined;
    const title = searchParams.get('title') || `OSIRIS Report ${new Date().toISOString().slice(0, 10)}`;

    const config: ReportConfig = {
      title,
      format: format as ReportConfig['format'],
      sections: ['executive_summary', 'statistics', 'ontology_entities', 'stance_analysis'],
      entityType,
      stanceTarget,
      maxEntities: 200,
      includeAIAnalysis: false,
    };

    const report = await generateReport(config);

    // Set appropriate content type
    const contentTypes: Record<string, string> = {
      html: 'text/html',
      csv: 'text/csv',
      markdown: 'text/markdown',
      json: 'application/json',
      xls: 'application/vnd.ms-excel',
      pdf: 'text/html',
    };

    const ext = config.format === 'pdf' ? 'html' : config.format;
    const ct = contentTypes[config.format] || 'text/plain';

    return new NextResponse(report.output, {
      status: 200,
      headers: {
        'Content-Type': ct,
        'Content-Disposition': `attachment; filename="${title.replace(/[^a-z0-9]/gi, '_')}.${ext}"`,
        'X-Report-Sections': report.sections.length.toString(),
        'X-Report-Size': report.size.toString(),
      },
    });
  } catch (e: any) {
    console.error('[Reports] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
