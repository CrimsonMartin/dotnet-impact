/**
 * External-change batching for save-independent run triggers (#10).
 *
 * Saves fire runs today via onDidSaveTextDocument; changes that land on disk
 * WITHOUT a save — `git checkout/pull/revert`, scripts, another editor —
 * arrive only as filesystem events. Those need different handling than saves:
 *
 *  - a save also produces a watcher event, and the save path must win
 *    (recorded saves suppress their own echo for a short window);
 *  - a file with a dirty editor open is mid-edit — the user's explicit save
 *    stays the trigger, the disk event is ignored;
 *  - git operations are batchy (a pull touches hundreds of files at once), so
 *    events collect under a rolling debounce and flush as ONE changed set.
 *    Large batches need no special casing downstream: computeAffected's
 *    map + fallback machinery already produces a sane run for any set size,
 *    and a whole-repo batch naturally approaches a full run.
 *
 * Pure logic — no vscode imports — so every decision here is unit-testable;
 * the extension wires the watcher, the dirty check, and executeRun around it.
 */

export type ChangeVerdict = "queued" | "not-source" | "recent-save" | "dirty-editor";

export interface ExternalBatcherOpts {
  /** Rolling burst window; longer than the save debounce so bursts coalesce. */
  debounceMs: () => number;
  /** Watcher echoes of a save arrive within this window of noteSave. */
  saveDedupMs: () => number;
  /** True when the file has an open editor with unsaved edits. */
  isDirtyInEditor: (fileAbs: string) => boolean;
  /** Receives each flushed burst as one changed-files set (absolute paths). */
  onBatch: (filesAbs: string[]) => void;
  /** Test seams. */
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export class ExternalChangeBatcher {
  private readonly pending = new Set<string>();
  private readonly savedAt = new Map<string, number>();
  private cancelFlush: (() => void) | null = null;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly opts: ExternalBatcherOpts) {
    this.now = opts.now ?? Date.now;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  /**
   * Record an editor save. Always call it — even when save-triggered runs are
   * disabled — so the save's own watcher echo never masquerades as an
   * external change.
   */
  noteSave(fileAbs: string): void {
    this.savedAt.set(fileAbs, this.now());
    if (this.savedAt.size > 4096) {
      // Opportunistic prune: drop entries far outside any dedup window.
      const cutoff = this.now() - 10 * this.opts.saveDedupMs();
      for (const [f, t] of this.savedAt) if (t < cutoff) this.savedAt.delete(f);
    }
  }

  /** Filesystem event (create/change/delete). Returns the decision, for logs and tests. */
  noteChange(fileAbs: string): ChangeVerdict {
    if (!isWatchableSource(fileAbs)) return "not-source";
    const saved = this.savedAt.get(fileAbs);
    if (saved !== undefined && this.now() - saved <= this.opts.saveDedupMs()) return "recent-save";
    if (this.opts.isDirtyInEditor(fileAbs)) return "dirty-editor";

    this.pending.add(fileAbs);
    // Rolling window: every event pushes the flush out, so a burst lands as
    // one batch shortly after its LAST event.
    this.cancelFlush?.();
    this.cancelFlush = this.schedule(() => this.flush(), this.opts.debounceMs());
    return "queued";
  }

  private flush(): void {
    this.cancelFlush = null;
    if (this.pending.size === 0) return;
    const files = [...this.pending];
    this.pending.clear();
    this.opts.onBatch(files);
  }

  dispose(): void {
    this.cancelFlush?.();
    this.cancelFlush = null;
    this.pending.clear();
  }
}

/**
 * Source files worth reacting to: the extensions the run pipeline handles,
 * excluding build output and VCS internals that watcher globs can't reliably
 * exclude on their own.
 */
export function isWatchableSource(fileAbs: string): boolean {
  if (!/\.(cs|razor|cshtml)$/i.test(fileAbs)) return false;
  const segments = fileAbs.split(/[\\/]+/).map((s) => s.toLowerCase());
  return !segments.some((s) => s === "bin" || s === "obj" || s === ".git" || s === "node_modules");
}
