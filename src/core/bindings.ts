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
 * ground truth and are never extended (see effectiveFiles).
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
      if (from === to) continue;
      const key = from + "\u0000" + to;
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
 * - First measurement (staticFiles given): Δ attribution ACTIVATES edges —
 *   one evidence class is enough (the #31 contract: a single measured class
 *   must transfer knowledge to never-measured ones; a false edge only costs
 *   extra tests).
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
    /** The static row this measurement replaces; null = re-measurement. */
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
 * Files that select a class on a changed-file lookup: the row's files plus,
 * for STATIC rows only, the targets of every binding attached to an
 * abstraction the class references. Measured rows are ground truth and are
 * never extended (the existing invariant).
 */
export function effectiveFiles(
  entry: { files: string[]; source?: "static" | "coverage" },
  abstractFiles: string[],
  table: BindingTable
): Set<string> {
  const out = new Set(entry.files);
  if ((entry.source ?? "coverage") !== "static") return out;
  for (const a of abstractFiles) for (const b of table[a.toLowerCase()] ?? []) out.add(b.to);
  return out;
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
