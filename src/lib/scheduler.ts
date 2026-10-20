import { dispatchAlerts } from "@/lib/alerts/queue";
import { dispatchNotices } from "@/lib/notices/queue";
import { pollTelegramLinks } from "@/lib/notices/telegram";
import { reconcilePendingPayments } from "@/lib/services/reconcile";
import { runScheduledSweep } from "@/lib/services/sweep";

/**
 * The portal drives itself: nothing here needs a visitor or an external cron.
 * The interval lives in the server process, so `next start` (or the Docker
 * container) is enough for holds to expire, payments to be confirmed against the
 * gateway, alerts to leave the queue and participants to be told about a draw.
 */

export const TICK_MS = 10_000;
export const JOB_SECONDS = { dispatch: 15, sweep: 60, reconcile: 90, telegram: 20 } as const;

export type JobName = keyof typeof JOB_SECONDS;
const JOBS = Object.keys(JOB_SECONDS) as JobName[];

export type JobState = { runs: number; lastRunAt: string | null; lastSummary: string };
export type SchedulerState = {
  enabled: boolean;
  startedAt: string | null;
  jobs: Record<JobName, JobState>;
};

type Runtime = {
  next: Record<JobName, number>;
  state: SchedulerState;
  ticking: boolean;
  timer: ReturnType<typeof setInterval> | null;
};

// dev reloads re-evaluate modules; keeping the timer on globalThis means one
// scheduler per process instead of one per reload
const holder = globalThis as unknown as { __luckyScheduler?: Runtime };

function runtime(): Runtime {
  if (!holder.__luckyScheduler) {
    const now = Date.now();
    holder.__luckyScheduler = {
      next: Object.fromEntries(JOBS.map((job) => [job, now])) as Record<JobName, number>,
      state: {
        enabled: false,
        startedAt: null,
        jobs: Object.fromEntries(
          JOBS.map((job) => [job, { runs: 0, lastRunAt: null, lastSummary: "" }]),
        ) as Record<JobName, JobState>,
      },
      ticking: false,
      timer: null,
    };
  }
  return holder.__luckyScheduler;
}

async function runJob(job: JobName) {
  const at = new Date();

  if (job === "sweep") {
    const result = await runScheduledSweep();
    return `released ${result.released}, complete ${result.checked}, drew ${result.draws.length}`;
  }
  if (job === "reconcile") {
    const result = await reconcilePendingPayments(at);
    return `checked ${result.checked}, settled ${result.settled}${result.error ? `, ${result.error}` : ""}`;
  }
  if (job === "telegram") {
    const result = await pollTelegramLinks();
    return `${result.note}${result.linked ? `, linked ${result.linked}` : ""}`;
  }
  const owner = await dispatchAlerts(at);
  const participants = await dispatchNotices(at);
  return `owner ${owner.sent}/${owner.queued}/${owner.failed}, participant ${participants.sent}/${participants.queued}/${participants.failed}`;
}

/** Runs one pass of every job that is due. Exported for the verification flow. */
export async function runDueJobs(now = new Date()) {
  const active = runtime();
  if (active.ticking) return [];
  active.ticking = true;

  const finished: string[] = [];
  try {
    for (const job of JOBS) {
      if (active.next[job] > now.getTime()) continue;
      active.next[job] = now.getTime() + JOB_SECONDS[job] * 1000;
      try {
        const summary = await runJob(job);
        active.state.jobs[job] = {
          runs: active.state.jobs[job].runs + 1,
          lastRunAt: now.toISOString(),
          lastSummary: summary,
        };
        finished.push(`${job}: ${summary}`);
      } catch (error) {
        // a failing job must not take the others down with it
        active.state.jobs[job] = {
          runs: active.state.jobs[job].runs,
          lastRunAt: now.toISOString(),
          lastSummary: `error ${(error as Error).name}`,
        };
        console.error("scheduler job failed", job, (error as Error).name);
      }
    }
  } finally {
    active.ticking = false;
  }
  return finished;
}

export function startScheduler() {
  const active = runtime();
  if (process.env.RUN_SCHEDULER?.trim().toLowerCase() === "false") return;
  if (active.timer) return;

  active.state.enabled = true;
  active.state.startedAt = new Date().toISOString();
  active.timer = setInterval(() => void runDueJobs(), TICK_MS);
  // never hold the process open on this timer alone (tests, scripts)
  active.timer.unref?.();
  void runDueJobs();
}

export function stopScheduler() {
  const active = runtime();
  if (active.timer) clearInterval(active.timer);
  active.timer = null;
  active.state.enabled = false;
}

export function schedulerStatus(): SchedulerState {
  return runtime().state;
}
