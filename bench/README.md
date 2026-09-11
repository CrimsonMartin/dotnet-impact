# Performance bench

Drives the real `Runner` / `HotPatcher` / `SessionRunner` stack against a
scaffolded large .NET solution and times the operations a user feels on a big
repo. All tuning work in this repo must measure with this harness before/after
and keep only meaningful wins.

## Fixture

`scaffold.mjs` generates a solution with **simple code, complex impact**:
every method is a one-liner, but the reference graph is multi-layered — deep
`Work()` call chains, high fan-in hub types (god-percent cap), a project-level
cycle across domains, interface fan-out, inlined enum constants (name-graph
union blind spot), generic `Box<T>`/`Pair<T,U>` instantiations (MethodSpec
edges), and convention-based reflection DI (invisible to static analysis).
`Core.Support.Do` is the hot-edit target: a trivial method body called by every
test class.

| size | projects | classes |
|------|----------|---------|
| small | 5 | ~60 (sanity/debug) |
| large | 17 | ~1700 (the "large dotnet repo" target) |

## Running

The bench needs `dotnet` (10.x) + `node` (>=18). The host may lack dotnet — run
inside the cached devcontainer image:

```bash
# 1. one container per concurrent bench (unique name!), repo copied in
docker run -d --name impact-bench-<you> mcr.microsoft.com/devcontainers/dotnet:10.0 sleep infinity
docker exec impact-bench-<you> bash -lc '
  apt-get update -qq && apt-get install -y -qq nodejs npm git >/dev/null 2>&1
  git config --global --add safe.directory /tmp/impact
  git config --global --add safe.directory /tmp/fixture
  # copy the repo in: on the host, tar it to a file, then
  #   docker cp <tarfile> impact-bench-<you>:/tmp/impact-repo.tar
  # (a bind mount of the repo also works if the container can see the path)
  mkdir -p /tmp/impact && tar -xf /tmp/impact-repo.tar -C /tmp/impact
  cd /tmp/impact && npm ci --cache /tmp/npm-cache && npm run compile
'

# 2. scaffold + run (inside the container)
docker exec impact-bench-<you> bash -lc '
  cd /tmp/impact
  node bench/scaffold.mjs /tmp/fixture large
  node bench/bench.mjs --root /tmp/fixture --ext /tmp/impact --label <label> --runs 3 --edits 10 --out /tmp/<label>.json
'

# 3. fetch results + tear down
docker cp impact-bench-<you>:/tmp/<label>.json ./bench/results/<label>.json
docker rm -f impact-bench-<you>
```

`--runs 3`: pass 1 is cold (fresh shadow + discovery cache), passes 2–3 are
steady-state; reported `steady_median_ms` uses passes 2+.

## Measurement protocol (mandatory for tuning PRs)

1. **Same fixture**: identical `scaffold.mjs` output (re-scaffold per run).
2. **Same container image**, same host, no other heavy jobs running.
3. **≥3 runs per label** (`--runs 3`), report the steady-state median.
4. **Both labels in the same environment session** (baseline → change, back to
   baseline if in doubt) — never compare numbers from different days/machines.
5. **Correctness gate**: the full `npm test` suite (in-container) must pass,
   and `fastpath hits` must not drop for `edit_cycle`.
6. `compare.mjs` produces the table that goes in the PR body.

## Ops measured

| op | what it covers |
|----|----------------|
| `prepare` | shadow ensure + overlay sync (fresh Runner) |
| `projectGraph` | first `buildProjectGraph` |
| `discoverAll` | solution build + parallel `--list-tests` |
| `buildMap` | static IL map helper over all assemblies |
| `computeAffected_100` | 100 random changed-file queries |
| `resync` | per-save `prepare()` with one dirty file |
| `edit_cycle` | N real method-body edits through the fast path (per-edit wall time, fastpath hits) |
| `refreshPending_2` | classic-coverage refresh of 2 classes |
