import * as fs from "fs";
import * as path from "path";
import { cacheDirFor } from "./util";

/**
 * Self-tuning map (#31): binding edges learned from coverage runs.
 *
 * The static IL map cannot see edges that only exist at runtime (convention-
 * based DI, reflection, fixture wiring). Every coverage refresh measures the
 * gap Δ = measured − static for free; Δ-mining attributes each newly-seen
 * file to the abstractions the class directly references, and the resulting
 * `A ⇒ B` binding is attached to the ABSTRACTION, not the class — so any
 * class referencing A inherits it, measured or not.
 *
 * Asymmetric by design: bindings only ADD files to static rows
 * (over-selection = a few extra tests), never remove. Measured rows are
 * ground truth and are never extended (see learnedSelection).
 *
 * One deliberate exception, MINED_CONFIRM_TO_COVER: a single-evidence MINED
 * edge may still select classes (safe over-selection), but it does not grant
 * "covered" status (suppression of the project-level fallback for its target
 * file) until a second confirmation. Δ attribution credits EVERY abstraction
 * the class references, so a one-measurement edge may be attached to the
 * wrong abstraction; suppressing the fallback on such an edge could shrink
 * selection (the fallback previously ran the whole project). Parsed seeds
 * name their types precisely and cover from the first sight.
 */

export interface Binding {
  /** Repo-relative source file of the dynamically-reached target. */
  to: string;
  /** How the edge was discovered. */
  source: "mined" | "parsed";
  /** Measurements of A-referencing classes in which `to` was hit. */
  confirms: number;
  /** Measurements of A-referencing classes in which `to` was NOT hit. */
  contradicts: number;
  /** ISO timestamp of the last confirmation. */
  lastSeen: string;
  /** Class FQNs whose Δ first implied this edge. */
  evidence: string[];
}

/**
 * Abstraction file → bindings attached to it. Contract: keys are
 * lower-cased repo-relative paths (case-insensitive FS safety; the store
 * enforces it on write, mirroring ImpactMap's inverted index).
 */
export type BindingTable = Record<string, Binding[]>;

/** Edges unconfirmed for this long are dropped (they relearn cheaply). */
export const DECAY_MS = 30 * 24 * 3600 * 1000;
/** Contradiction drop thresholds — deliberately lopsided toward keeping: a
 * false edge costs extra tests, a dropped true edge costs under-selection.
 * A true binding re-confirms on every measurement of an A-referencing class
 * that exercises the path, while a dead one contradicts on all of them; but a
 * class whose tests never touch the DI path is weak evidence either way. */
export const CONTRADICT_MIN = 4;
export const CONTRADICT_RATIO = 2;
/**
 * How many confirmations a MINED edge needs before its target file counts as
 * "covered" (suppressed out of the project-level fallback). Parsed edges
 * cover immediately. See the module header for the rationale.
 */
export const MINED_CONFIRM_TO_COVER = 2;

export function shouldDrop(b: Binding): boolean {
  return b.contradicts >= CONTRADICT_MIN && b.contradicts > CONTRADICT_RATIO * b.confirms;
}

/**
 * Δ attribution: files a measurement revealed beyond the static closure,
 * attributed to EVERY abstraction the class directly references. At most one
 * (from, to) pair per combination; `to === from` is skipped (a file cannot
 * be its own dynamic target).
 */
export function mineDelta(opts: {
  staticFiles: string[];
  measuredFiles: string[];
  abstractFiles: string[];
}): Array<{ from: string; to: string }> {
  const staticSet = new Set(opts.staticFiles);
  const out: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const to of opts.measuredFiles) {
    if (staticSet.has(to)) continue;
    for (const from of opts.abstractFiles) {
      if (from.toLowerCase() === to.toLowerCase()) continue; // same file (case-insensitive FS)
      const key = from.toLowerCase() + "\u0000" + to.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, to });
    }
  }
  return out;
}

/**
 * Apply one class measurement to the table (pure).
 *
 * - Baseline present (a row — static or the previous coverage row): Δ =
 *   measured − baseline attribution ACTIVATES edges for files newly seen
 *   since the baseline — one evidence class is enough (the #31 contract: a
 *   single measured class must transfer knowledge to never-measured ones; a
 *   false edge only costs extra tests). Using the previous COVERAGE row as
 *   baseline (not "static or nothing") is what lets a changed world teach a
 *   new edge: when the convention flips to a different implementation, the
 *   freshly-appearing impl file is attributed, the old impl's edge starts
 *   accumulating contradictions, and the new reality is learned in the same
 *   measurements.
 * - Every measurement: each known edge for a referenced abstraction is
 *   confirmed (target hit) or contradicted (target not hit). An edge
 *   activated by THIS measurement is not double-confirmed.
 * - Edges that cross the contradiction threshold are dropped.
 */
export function applyMeasurement(
  table: BindingTable,
  m: {
    classFqn: string;
    abstractFiles: string[];
    measuredFiles: string[];
    /** The row this measurement replaces (static or previous coverage); null = no row. */
    staticFiles: string[] | null;
    now: string;
  }
): BindingTable {
  const next: BindingTable = {};
  for (const [k, v] of Object.entries(table)) next[k] = [...v];
  const list = (from: string): Binding[] => {
    const k = from.toLowerCase(); // key contract: lower-cased
    if (!next[k]) next[k] = [];
    return next[k];
  };

  const activated = new Set<string>();
  if (m.staticFiles) {
    for (const { from, to } of mineDelta({
      staticFiles: m.staticFiles,
      measuredFiles: m.measuredFiles,
      abstractFiles: m.abstractFiles,
    })) {
      const l = list(from);
      let b = l.find((x) => x.to === to);
      if (!b) {
        b = { to, source: "mined", confirms: 0, contradicts: 0, lastSeen: m.now, evidence: [] };
        l.push(b);
      }
      b.confirms += 1;
      b.lastSeen = m.now;
      if (!b.evidence.includes(m.classFqn)) b.evidence.push(m.classFqn);
      activated.add(from + "\u0000" + to);
    }
  }

  const measured = new Set(m.measuredFiles);
  for (const from of m.abstractFiles) {
    for (const b of list(from)) {
      if (activated.has(from + "\u0000" + b.to)) continue;
      if (measured.has(b.to)) {
        b.confirms += 1;
        b.lastSeen = m.now;
      } else {
        b.contradicts += 1;
      }
    }
  }

  for (const [k, l] of Object.entries(next)) {
    const kept = l.filter((b) => !shouldDrop(b));
    if (kept.length > 0) next[k] = kept;
    else delete next[k];
  }
  return next;
}

/** Drop edges unconfirmed for longer than DECAY_MS. */
export function decayBindings(table: BindingTable, nowMs: number): BindingTable {
  const next: BindingTable = {};
  for (const [k, l] of Object.entries(table)) {
    const kept = l.filter((b) => nowMs - Date.parse(b.lastSeen) <= DECAY_MS);
    if (kept.length > 0) next[k] = kept;
  }
  return next;
}

/**
 * Drop bindings whose abstraction or target file no longer exists in the
 * tree. `existingFiles` is the lower-cased repo-relative tree; `to` keeps
 * its original case for display, so comparison is lower-cased.
 */
export function pruneBindings(table: BindingTable, existingFiles: Set<string>): BindingTable {
  const next: BindingTable = {};
  for (const [k, l] of Object.entries(table)) {
    if (!existingFiles.has(k)) continue;
    const kept = l.filter((b) => existingFiles.has(b.to.toLowerCase()));
    if (kept.length > 0) next[k] = kept;
  }
  return next;
}

/**
 * Query-time application: which classes selected bindings extend.
 *
 * For each changed file that is a binding target, every class whose row is
 * STATIC and whose abstractFiles contain the binding's abstraction is
 * selected (measured rows are ground truth — never extended).
 *
 * A changed file that at least one such class reaches via a binding is
 * "covered": its effective closure now touches it, so callers stop treating
 * it as unknown (no project-level fallback). Covered status is the ONE place
 * a learned edge can reduce selection relative to the fallback, so it is
 * earned, not assumed (see MINED_CONFIRM_TO_COVER): a parsed seed covers from
 * the first sight; a mined edge covers only from its second confirmation.
 * Until then the target file still triggers the project-level fallback — the
 * pre-#31 safety net — while the binding already selects its classes
 * (over-selection, the safe direction). Returns both the selected classes
 * and the covered files (lower-cased).
 */
export function learnedSelection(opts: {
  changedFiles: string[];
  table: BindingTable;
  classes: Array<{
    fqn: string;
    source?: "static" | "coverage";
    abstractFiles: string[];
  }>;
}): { classes: Set<string>; covered: Set<string> } {
  const byTarget = new Map<
    string,
    Array<{ from: string; source: "mined" | "parsed"; confirms: number }>
  >(); // target(lower) -> edges
  for (const [from, list] of Object.entries(opts.table))
    for (const b of list) {
      const k = b.to.toLowerCase();
      if (!byTarget.has(k)) byTarget.set(k, []);
      byTarget.get(k)!.push({ from, source: b.source, confirms: b.confirms });
    }
  const classes = new Set<string>();
  const covered = new Set<string>();
  for (const f of opts.changedFiles) {
    const edges = byTarget.get(f.toLowerCase());
    if (!edges) continue;
    let hit = false;
    for (const cls of opts.classes) {
      if ((cls.source ?? "coverage") !== "static") continue; // measured rows: ground truth
      const refs = new Set(cls.abstractFiles.map((a) => a.toLowerCase()));
      if (edges.some((e) => refs.has(e.from))) {
        classes.add(cls.fqn);
        hit = true;
      }
    }
    // Covered only when a class is actually selected AND some edge grants it:
    // parsed (precise by construction) or mined with >= MINED_CONFIRM_TO_COVER.
    if (hit && edges.some((e) => e.source === "parsed" || e.confirms >= MINED_CONFIRM_TO_COVER))
      covered.add(f.toLowerCase());
  }
  return { classes, covered };
}

/**
 * Active-learning selection (#31 step 4): which UNMEASURED class's
 * measurement would teach the most.
 *
 * An abstraction is UNRESOLVED when no binding covers it AND no measured
 * class references it — a measured class's run (even one with an empty Δ)
 * teaches that its abstractions expose no dynamic edge from that path, so
 * sampling more classes that share it is wasted. Score(T) is the sum, over
 * T's unresolved abstractions, of how many unmeasured classes share each:
 * measuring T resolves that abstraction for all of them. Deterministic:
 * score descending, FQN ascending; at most `budget` classes.
 */
export function selectLearningTargets(opts: {
  unmeasured: Array<{ classFqn: string; abstractFiles: string[] }>;
  /** Abstraction files referenced by any MEASURED class (resolved, no edge). */
  measuredAbstractFiles: Set<string>;
  table: BindingTable;
  budget: number;
}): string[] {
  const known = new Set<string>(Object.keys(opts.table));
  for (const a of opts.measuredAbstractFiles) known.add(a.toLowerCase());
  const share = new Map<string, number>();
  for (const c of opts.unmeasured)
    for (const a of c.abstractFiles) {
      const k = a.toLowerCase();
      if (known.has(k)) continue;
      share.set(k, (share.get(k) ?? 0) + 1);
    }
  return opts.unmeasured
    .map((c) => {
      let score = 0;
      for (const a of c.abstractFiles) {
        const k = a.toLowerCase();
        if (!known.has(k)) score += share.get(k) ?? 0;
      }
      return { fqn: c.classFqn, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || (x.fqn < y.fqn ? -1 : x.fqn > y.fqn ? 1 : 0))
    .slice(0, opts.budget)
    .map((x) => x.fqn);
}

/** Persisted per-repo store for learned bindings. */
export class LearnedBindings {
  private table: BindingTable = {};
  private readonly file: string;

  constructor(private readonly repoRoot: string) {
    this.file = path.join(cacheDirFor(repoRoot), "learned-bindings.json");
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (loaded?.version === 1 && loaded.bindings && typeof loaded.bindings === "object")
        this.table = loaded.bindings;
    } catch {
      /* fresh store */
    }
  }

  get count(): number {
    let n = 0;
    for (const l of Object.values(this.table)) n += l.length;
    return n;
  }

  /** Total + per-source breakdown (status/telemetry). */
  get summary(): { total: number; mined: number; parsed: number } {
    let mined = 0;
    let parsed = 0;
    for (const l of Object.values(this.table))
      for (const b of l) (b.source === "mined" ? mined++ : parsed++);
    return { total: mined + parsed, mined, parsed };
  }

  /** All bindings attached to an abstraction file (case-insensitive). */
  bindingsFor(from: string): Binding[] {
    return this.table[from.toLowerCase()] ?? [];
  }

  get tableSnapshot(): BindingTable {
    return this.table;
  }

  /** Apply one measurement (mining window + confirm/contradict) and persist. */
  observeMeasurement(m: Parameters<typeof applyMeasurement>[1]): void {
    this.table = applyMeasurement(this.table, m);
    this.save();
  }

  /**
   * Seed parsed-registration edges (#31 step 3): added only where no binding
   * (mined or parsed) already covers the same pair — mined evidence wins.
   * Returns how many were added.
   */
  seedParsed(
    edges: Array<{ from: string; to: string }>,
    now: string = new Date().toISOString()
  ): number {
    let added = 0;
    for (const { from, to } of edges) {
      const k = from.toLowerCase();
      if (!this.table[k]) this.table[k] = [];
      if (this.table[k].some((b) => b.to.toLowerCase() === to.toLowerCase())) continue;
      this.table[k].push({ to, source: "parsed", confirms: 1, contradicts: 0, lastSeen: now, evidence: [] });
      added++;
    }
    if (added > 0) this.save();
    return added;
  }

  /** Staleness decay (buildMap time). */
  decay(nowMs = Date.now()): void {
    this.table = decayBindings(this.table, nowMs);
    this.save();
  }

  /** Path prune (buildMap time): `existingFiles` lower-cased repo-relative. */
  prune(existingFiles: Set<string>): void {
    this.table = pruneBindings(this.table, existingFiles);
    this.save();
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, bindings: this.table }, null, 1));
    } catch {
      /* best-effort: losing the store costs relearning, not correctness */
    }
  }
}
