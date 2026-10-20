/**
 * Next.js server start hook. Everything that has to happen without a visitor
 * begins here: the sweep of expired holds, the gateway check for payments whose
 * notification never arrived, and the alert queue.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` also loads this file while collecting page data; the jobs write
  // to the database, so a build must never start them
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
}
