/**
 * After a subset run, the Testing view's counter would read "3/3" — only the
 * tests that ran. To settle it at "all/all", every previously-run method that
 * this run did NOT touch re-reports its last known result at run end.
 *
 * Terminal states only, and only at the end: emitting queued/started markers
 * for the untouched suite up front would flip every item to the yellow
 * "queued" icon for the whole run (shipped briefly in v0.1.2, reverted).
 */

export interface KnownResult {
  classFqn: string;
  passed: boolean;
  skipped: boolean;
  duration: number;
  message?: string;
}

export interface ReplayEvent {
  methodFqn: string;
  state: "passed" | "failed" | "skipped";
  duration: number;
  message?: string;
}

/**
 * Results to re-emit at the end of a subset run: last known state of every
 * method that did not get a real result this run (`reported`).
 */
export function replayEvents(
  known: Map<string, KnownResult>,
  reported: Set<string>
): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  for (const [methodFqn, r] of known) {
    if (reported.has(methodFqn)) continue;
    out.push({
      methodFqn,
      state: r.skipped ? "skipped" : r.passed ? "passed" : "failed",
      duration: r.duration,
      message: r.message,
    });
  }
  return out;
}
