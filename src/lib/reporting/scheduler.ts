/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Report Scheduler
 *
 *  In-process scheduler for recurring report generation and
 *  delivery. Stores scheduled jobs in memory, checks every
 *  60 seconds for jobs due to fire, generates the report,
 *  and delivers via the configured webhook or email.
 *
 *  API: create, list, delete, trigger, get-status
 * ═══════════════════════════════════════════════════════════════
 */

import { generateReport, deliverReport, type ReportConfig, type DeliveryConfig, type CompiledReport } from './generator';

// ──────────────────────────────────────────────────────────────
//  TYPES
// ──────────────────────────────────────────────────────────────

export interface ScheduledReport {
  id: string;
  name: string;
  /** Cron expression or interval string: 'daily', 'weekly', 'hourly', or cron pattern */
  schedule: string;
  /** Report configuration */
  config: ReportConfig;
  /** Delivery configuration */
  delivery?: DeliveryConfig;
  /** Whether this schedule is active */
  active: boolean;
  /** When this schedule was created */
  createdAt: string;
  /** When this schedule was last run */
  lastRunAt: string | null;
  /** When this schedule should run next */
  nextRunAt: string | null;
  /** Total runs so far */
  runCount: number;
  /** Last run result */
  lastResult?: {
    success: boolean;
    sizeKB: number;
    sections: number;
    delivered: boolean;
    error?: string;
    ranAt: string;
  };
}

// ──────────────────────────────────────────────────────────────
//  SCHEDULER STATE
// ──────────────────────────────────────────────────────────────

const scheduledJobs: Map<string, ScheduledReport> = new Map();
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL_MS = 60_000; // check every 60 seconds

// ──────────────────────────────────────────────────────────────
//  CRON-LIKE SCHEDULE PARSING
// ──────────────────────────────────────────────────────────────

/**
 * Parse a schedule string into a function that checks if the
 * current time matches.
 *
 * Supports:
 *   'hourly'           — every hour at :00
 *   'daily'            — every day at 00:00
 *   'weekly'           — every Monday at 00:00
 *   '/5 * * * *'     — every 5 minutes (cron-like, minute field only)
 *   '0 /2 * * *'     — every 2 hours
 *   ISO interval like '30m', '2h', '1d'
 */
function parseSchedule(schedule: string): () => boolean {
  const now = new Date();

  // Named schedules
  if (schedule === 'hourly') {
    return () => new Date().getMinutes() === 0;
  }
  if (schedule === 'daily') {
    return () => new Date().getHours() === 0 && new Date().getMinutes() === 0;
  }
  if (schedule === 'weekly') {
    return () => new Date().getDay() === 1 && new Date().getHours() === 0 && new Date().getMinutes() === 0;
  }

  // Simple cron: '*/N * * * *' or '* * * * *'
  const cronMatch = schedule.match(/^\*\/?(\d+)?\s+\*\s+\*\s+\*\s+\*$/);
  if (cronMatch) {
    const interval = parseInt(cronMatch[1] || '1', 10);
    return () => new Date().getMinutes() % interval === 0;
  }

  // '0 */N * * *' — every N hours
  const hourMatch = schedule.match(/^0\s+\*\/?(\d+)?\s+\*\s+\*\s+\*$/);
  if (hourMatch) {
    const interval = parseInt(hourMatch[1] || '1', 10);
    return () => new Date().getMinutes() === 0 && new Date().getHours() % interval === 0;
  }

  // ISO-style: '30m', '2h', '1d'
  const isoMatch = schedule.match(/^(\d+)(m|h|d)$/);
  if (isoMatch) {
    const value = parseInt(isoMatch[1], 10);
    const unit = isoMatch[2];
    const intervalMs = unit === 'm' ? value * 60_000 : unit === 'h' ? value * 3600_000 : value * 86400_000;
    let lastFired = 0;
    return () => {
      const t = Date.now();
      if (t - lastFired >= intervalMs) {
        lastFired = t;
        return true;
      }
      return false;
    };
  }

  // Default: run every 5 minutes
  return () => new Date().getMinutes() % 5 === 0;
}

function computeNextRun(schedule: string): string {
  // Simple: compute next minute boundary
  if (schedule === 'hourly') {
    const d = new Date(); d.setMinutes(60, 0, 0); return d.toISOString();
  }
  if (schedule === 'daily') {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.toISOString();
  }
  if (schedule === 'weekly') {
    const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(0, 0, 0, 0); return d.toISOString();
  }
  // Default: 5 min from now
  const d = new Date(Date.now() + 5 * 60_000);
  return d.toISOString();
}

// ──────────────────────────────────────────────────────────────
//  SCHEDULER ENGINE
// ──────────────────────────────────────────────────────────────

/**
 * Initialize the scheduler (called once at startup).
 */
export function initScheduler(): void {
  if (schedulerInterval) return;
  console.log('[ReportScheduler] Starting scheduler (check interval: 60s)');
  schedulerInterval = setInterval(checkAndRunJobs, CHECK_INTERVAL_MS);
  // Run an immediate check
  setTimeout(checkAndRunJobs, 10_000);
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

/**
 * Check all jobs and run any that are due.
 */
async function checkAndRunJobs(): Promise<void> {
  const now = new Date();
  const jobsToRun: ScheduledReport[] = [];

  for (const job of scheduledJobs.values()) {
    if (!job.active) continue;

    const shouldRun = parseSchedule(job.schedule);
    if (shouldRun()) {
      // Prevent running twice in the same minute
      if (job.lastRunAt) {
        const lastRun = new Date(job.lastRunAt);
        const diffMs = now.getTime() - lastRun.getTime();
        if (diffMs < 60_000) continue; // already ran within the last minute
      }
      jobsToRun.push(job);
    }
  }

  for (const job of jobsToRun) {
    await runJob(job.id);
  }
}

/**
 * Execute a scheduled report job: generate + deliver.
 */
async function runJob(jobId: string): Promise<void> {
  const job = scheduledJobs.get(jobId);
  if (!job) return;

  try {
    const report = await generateReport(job.config);

    let delivered = false;
    if (job.delivery?.webhookUrl || job.delivery?.emailTo) {
      const deliveryResult = await deliverReport(report, job.delivery!);
      delivered = !!(deliveryResult.webhook?.ok || deliveryResult.email?.sent);
    }

    job.lastRunAt = new Date().toISOString();
    job.nextRunAt = computeNextRun(job.schedule);
    job.runCount++;
    job.lastResult = {
      success: true,
      sizeKB: Math.round(report.size / 1024),
      sections: report.sections.length,
      delivered,
      ranAt: job.lastRunAt,
    };

    // Log the run
    console.log(`[ReportScheduler] Job "${job.name}" ran: ${report.size}b, ${report.sections} sections, delivered=${delivered}`);
  } catch (err: any) {
    job.lastRunAt = new Date().toISOString();
    job.nextRunAt = computeNextRun(job.schedule);
    job.lastResult = {
      success: false,
      sizeKB: 0,
      sections: 0,
      delivered: false,
      error: err.message,
      ranAt: job.lastRunAt,
    };
    console.error(`[ReportScheduler] Job "${job.name}" failed: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
//  JOB CRUD
// ──────────────────────────────────────────────────────────────

/**
 * Create a new scheduled report job.
 */
export function createScheduledReport(params: {
  name: string;
  schedule: string;
  config: ReportConfig;
  delivery?: DeliveryConfig;
}): ScheduledReport {
  const job: ScheduledReport = {
    id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: params.name,
    schedule: params.schedule,
    config: params.config,
    delivery: params.delivery,
    active: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    nextRunAt: computeNextRun(params.schedule),
    runCount: 0,
  };

  scheduledJobs.set(job.id, job);
  console.log(`[ReportScheduler] Created job "${job.name}" (${job.id}) schedule=${job.schedule}`);
  return job;
}

/**
 * List all scheduled report jobs.
 */
export function listScheduledReports(): ScheduledReport[] {
  return [...scheduledJobs.values()];
}

/**
 * Get a single scheduled report job.
 */
export function getScheduledReport(jobId: string): ScheduledReport | undefined {
  return scheduledJobs.get(jobId);
}

/**
 * Delete a scheduled report job.
 */
export function deleteScheduledReport(jobId: string): boolean {
  return scheduledJobs.delete(jobId);
}

/**
 * Update a scheduled report job.
 */
export function updateScheduledReport(
  jobId: string,
  updates: Partial<Pick<ScheduledReport, 'name' | 'schedule' | 'config' | 'delivery' | 'active'>>,
): ScheduledReport | null {
  const job = scheduledJobs.get(jobId);
  if (!job) return null;

  if (updates.name !== undefined) job.name = updates.name;
  if (updates.schedule !== undefined) {
    job.schedule = updates.schedule;
    job.nextRunAt = computeNextRun(updates.schedule);
  }
  if (updates.config !== undefined) job.config = updates.config;
  if (updates.delivery !== undefined) job.delivery = updates.delivery;
  if (updates.active !== undefined) job.active = updates.active;

  return job;
}

/**
 * Trigger a job to run immediately.
 */
export async function triggerJob(jobId: string): Promise<{ success: boolean; error?: string }> {
  const job = scheduledJobs.get(jobId);
  if (!job) return { success: false, error: 'Job not found' };

  await runJob(jobId);
  const result = job.lastResult;
  if (result?.success) return { success: true };
  return { success: false, error: result?.error || 'Run failed' };
}
