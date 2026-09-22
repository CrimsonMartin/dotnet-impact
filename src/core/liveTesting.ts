/**
 * Live testing — the Impact eye in the Testing toolbar.
 *
 *   open eye    → ON: a saved source file runs its affected tests (debounced)
 *                 and out-of-band changes (git checkout/pull) run at once.
 *   crossed eye → PAUSED: the in-flight run is cancelled immediately and
 *                 nothing runs; every change that lands meanwhile is kept.
 *   resume      → whatever changed during the pause runs right away — the
 *                 cancelled run's files included — then saves run again.
 *
 * Live testing is on at every startup: a pause is a per-window choice. A run
 * cancelled by a pause never re-baselines the startup digest (#33), so an
 * edit that was paused away and then closed on runs at the next startup.
 *
 * Pure (no vscode import) so the pause/resume/pending semantics are unit-
 * testable; timers are injected for the same reason.
 */
export interface LiveTestingHost {
  /** Run the affected tests for `files`, or the full suite when undefined. */
  run(files: string[] | undefined): void;
  /**
   * Cancel the in-flight run, if any, and say what it was running: its
   * changed files, or `files: undefined` for a full-suite run. Null when
   * nothing was in flight.
   */
  abortInFlight(): { files: string[] | undefined } | null;
  /** The state flipped: refresh the toolbar icon, status bar, log. */
  onChange(on: boolean): void;
  debounceMs(): number;
}

export interface LiveTestingTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: LiveTestingTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class LiveTesting {
  private _on = true;
  /** Changed files not yet run: debouncing while on, waiting while paused. */
  private readonly pending = new Set<string>();
  /** A full-suite run cancelled by a pause waits for resume as well. */
  private pendingAll = false;
  private debounce: unknown;

  constructor(
    private readonly host: LiveTestingHost,
    private readonly timers: LiveTestingTimers = realTimers
  ) {}

  get on(): boolean {
    return this._on;
  }

  /** A source file was saved in the editor. */
  noteSave(file: string): void {
    this.pending.add(file);
    if (!this._on) return; // kept for resume
    this.timers.clear(this.debounce);
    this.debounce = this.timers.set(() => this.flush(), this.host.debounceMs());
  }

  /** Files changed out-of-band; the caller has already batched them. */
  noteChanged(files: string[]): void {
    for (const f of files) this.pending.add(f);
    if (this._on) this.flush();
  }

  pause(): void {
    if (!this._on) return;
    this._on = false;
    this.clearDebounce();
    const aborted = this.host.abortInFlight();
    if (aborted) {
      if (aborted.files) for (const f of aborted.files) this.pending.add(f);
      else this.pendingAll = true;
    }
    this.host.onChange(false);
  }

  resume(): void {
    if (this._on) return;
    this._on = true;
    this.host.onChange(true);
    if (this.pendingAll || this.pending.size > 0) this.flush();
  }

  toggle(): void {
    if (this._on) this.pause();
    else this.resume();
  }

  dispose(): void {
    this.clearDebounce();
  }

  private clearDebounce(): void {
    this.timers.clear(this.debounce);
    this.debounce = undefined;
  }

  private flush(): void {
    this.clearDebounce();
    const all = this.pendingAll;
    const files = [...this.pending];
    this.pendingAll = false;
    this.pending.clear();
    if (all) this.host.run(undefined); // the full suite subsumes the files
    else if (files.length > 0) this.host.run(files);
  }
}
