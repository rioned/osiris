/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Report Scheduling API
 *
 *  GET  /api/reports/schedule          — list all scheduled reports
 *  POST /api/reports/schedule          — create a scheduled report
 *  POST /api/reports/schedule?action=trigger  — trigger a job now
 *  POST /api/reports/schedule?action=delete   — delete a job
 *  POST /api/reports/schedule?action=update   — update a job
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  initScheduler,
  createScheduledReport,
  listScheduledReports,
  getScheduledReport,
  deleteScheduledReport,
  updateScheduledReport,
  triggerJob,
} from '@/lib/reporting/scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Ensure the scheduler is running
initScheduler();

export async function GET() {
  try {
    const jobs = listScheduledReports();
    // Return without full report output (only metadata)
    const summary = jobs.map(j => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      format: j.config.format,
      sections: j.config.sections || 'all',
      active: j.active,
      createdAt: j.createdAt,
      lastRunAt: j.lastRunAt,
      nextRunAt: j.nextRunAt,
      runCount: j.runCount,
      lastResult: j.lastResult,
    }));

    return NextResponse.json({
      success: true,
      count: summary.length,
      jobs: summary,
    });
  } catch (e: any) {
    console.error('[Schedule] GET error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action || 'create';

    switch (action) {
      case 'create': {
        const { name, schedule, config, delivery } = body;
        if (!name || !schedule || !config) {
          return NextResponse.json({
            error: 'name, schedule, and config required',
          }, { status: 400 });
        }

        const job = createScheduledReport({
          name,
          schedule,
          config: {
            title: config.title || name,
            format: config.format || 'html',
            sections: config.sections,
            entityType: config.entityType,
            stanceTarget: config.stanceTarget,
            maxEntities: config.maxEntities || 200,
            includeAIAnalysis: config.includeAIAnalysis !== false,
            brandColor: config.brandColor,
            organization: config.organization,
          },
          delivery: delivery ? {
            webhookUrl: delivery.webhookUrl,
            emailTo: delivery.emailTo,
            smtp: delivery.smtp,
          } : undefined,
        });

        return NextResponse.json({
          success: true,
          job: {
            id: job.id,
            name: job.name,
            schedule: job.schedule,
            nextRunAt: job.nextRunAt,
            active: job.active,
          },
        });
      }

      case 'trigger': {
        const { jobId } = body;
        if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

        const job = getScheduledReport(jobId);
        if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

        const result = await triggerJob(jobId);
        return NextResponse.json({
          success: result.success,
          error: result.error,
          job: {
            id: job.id,
            name: job.name,
            lastRunAt: job.lastRunAt,
            lastResult: job.lastResult,
          },
        });
      }

      case 'delete': {
        const { jobId } = body;
        if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

        const deleted = deleteScheduledReport(jobId);
        return NextResponse.json({
          success: deleted,
          message: deleted ? 'Job deleted' : 'Job not found',
        });
      }

      case 'update': {
        const { jobId, ...updates } = body;
        if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

        const updated = updateScheduledReport(jobId, {
          name: updates.name,
          schedule: updates.schedule,
          config: updates.config,
          delivery: updates.delivery ? {
            webhookUrl: updates.delivery.webhookUrl,
            emailTo: updates.delivery.emailTo,
            smtp: updates.delivery.smtp,
          } : undefined,
          active: updates.active,
        });

        if (!updated) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

        return NextResponse.json({
          success: true,
          job: {
            id: updated.id,
            name: updated.name,
            schedule: updated.schedule,
            nextRunAt: updated.nextRunAt,
            active: updated.active,
          },
        });
      }

      default:
        return NextResponse.json({
          actions: {
            create: { name: 'required', schedule: 'required', config: 'required', delivery: 'optional' },
            trigger: { jobId: 'required' },
            delete: { jobId: 'required' },
            update: { jobId: 'required', name: 'optional', schedule: 'optional', config: 'optional', delivery: 'optional', active: 'optional' },
          },
        });
    }
  } catch (e: any) {
    console.error('[Schedule] POST error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
