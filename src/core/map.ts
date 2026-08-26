import * as fs from "fs";
import * as path from "path";
import { cacheDirFor } from "./util";

export interface MapEntry {
  csproj: string; // repo-relative path of the owning test project
  files: string[]; // repo-relative source files this class's tests execute
  updatedAt: string;
}

export interface ImpactMapData {
  version: 1;
  entries: Record<string, MapEntry>; // key: test class FQN
}

export class ImpactMap {
  private data: ImpactMapData;
  private inverted: Map<string, Set<string>> | null = null; // file -> class FQNs
  private readonly file: string;

  constructor(private readonly repoRoot: string) {
    this.file = path.join(cacheDirFor(repoRoot), "impact-map.json");
    this.data = { version: 1, entries: {} };
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (loaded?.version === 1) this.data = loaded;
    } catch {
      /* fresh map */
    }
  }

  get classCount(): number {
    return Object.keys(this.data.entries).length;
  }

  classes(): string[] {
    return Object.keys(this.data.entries);
  }

  has(classFqn: string): boolean {
    return classFqn in this.data.entries;
  }

  entry(classFqn: string): MapEntry | undefined {
    return this.data.entries[classFqn];
  }

  update(classFqn: string, csproj: string, files: string[]): void {
    this.data.entries[classFqn] = { csproj, files, updatedAt: new Date().toISOString() };
    this.inverted = null;
  }

  remove(classFqn: string): void {
    delete this.data.entries[classFqn];
    this.inverted = null;
  }

  /**
   * Drop entries for classes that no longer exist. `discovered` maps each
   * successfully-discovered test project (repo-relative csproj) to its live
   * class FQNs: entries in those projects but not those sets die, as do
   * entries whose project is gone from the graph. Entries in a live project
   * whose discovery failed this round are kept (no evidence they died).
   * Returns the removed class FQNs.
   */
  prune(discovered: Map<string, Set<string>>, liveProjects: Set<string>): string[] {
    const removed: string[] = [];
    for (const [cls, e] of Object.entries(this.data.entries)) {
      const live = discovered.get(e.csproj);
      if (live ? !live.has(cls) : !liveProjects.has(e.csproj)) removed.push(cls);
    }
    for (const cls of removed) this.remove(cls);
    return removed;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }

  private invert(): Map<string, Set<string>> {
    if (!this.inverted) {
      this.inverted = new Map();
      for (const [cls, e] of Object.entries(this.data.entries)) {
        for (const f of e.files) {
          const key = f.toLowerCase();
          if (!this.inverted.has(key)) this.inverted.set(key, new Set());
          this.inverted.get(key)!.add(cls);
        }
      }
    }
    return this.inverted;
  }

  /**
   * Classes whose tests execute any of the changed files (repo-relative paths).
   * `unknownFiles` receives every changed file no mapped test touches — callers
   * decide which of those warrant project-level fallback.
   */
  affectedClasses(changedFiles: string[], unknownFiles?: string[]): string[] {
    const idx = this.invert();
    const classes = new Set<string>();
    for (const f of changedFiles) {
      const hits = idx.get(f.split(path.sep).join("/").toLowerCase());
      if (hits) for (const c of hits) classes.add(c);
      else unknownFiles?.push(f);
    }
    return [...classes].sort();
  }
}
