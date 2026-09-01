# Impact in CI: affected-only test runs on PR diffs

The impact map answers "which tests does this diff affect" — the same answer
that powers save-time runs in the editor. In CI it means a PR build runs the
affected slice in seconds while a full run stays on merge/main.

The loop:

```
impact build-map --if-missing        # no-op when the cache restored a map
impact run --base <PR base sha> --ci # affected tests only; exit 1 on failure
```

`--ci` flips the CLI's hook-safety rule: locally, a missing map or a busy
shadow warns and exits 0 so a commit is never blocked on infrastructure — in
a pipeline that same soft skip would green-light an untested PR, so `--ci`
exits 1 with the reason instead. Exit codes: 0 = affected tests passed or
nothing affected, 1 = failures (or, under `--ci`, missing infrastructure),
2 = usage.

## Getting the CLI onto a runner

The CLI ships inside the extension package and is not on npm yet. The honest
path today is building it from a checkout (about 20s, cacheable like any npm
dep):

```yaml
- uses: actions/checkout@v4
  with:
    repository: CrimsonMartin/dotnet-impact
    ref: v0.2.10            # pin a release tag
    path: .impact-cli
- run: npm ci --prefix .impact-cli && npm run compile --prefix .impact-cli
# then: node .impact-cli/out/cli.js <command>
```

## Complete workflow

```yaml
name: affected-tests
on: pull_request

jobs:
  affected:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # --base needs the PR base commit reachable

      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: 10.0.x
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Get impact CLI
        uses: actions/checkout@v4
        with:
          repository: CrimsonMartin/dotnet-impact
          ref: v0.2.10
          path: .impact-cli
      - run: npm ci --prefix .impact-cli && npm run compile --prefix .impact-cli

      # All impact state lives under ~/.impact/<repo>-<hash>. The hash covers
      # the absolute checkout path, which is stable on GitHub runners
      # (/home/runner/work/<repo>/<repo>), so the cache lines up run to run.
      # The shadow git worktree is excluded: it wires absolute paths into the
      # previous runner's checkout and must be recreated fresh instead.
      - name: Restore impact map
        uses: actions/cache@v4
        with:
          path: |
            ~/.impact
            !~/.impact/*/shadow
          key: impact-${{ runner.os }}-${{ hashFiles('**/*.csproj', '**/*.sln', '**/*.slnx') }}
          restore-keys: impact-${{ runner.os }}-

      - name: Build impact map (first run only)
        run: node .impact-cli/out/cli.js build-map --if-missing

      - name: Run affected tests
        run: node .impact-cli/out/cli.js run --base ${{ github.event.pull_request.base.sha }} --ci
```

The first PR on a cold cache pays the map build (a full solution build plus
the static map — roughly your build time plus seconds); every run after that
restores the map and goes straight to the affected slice. Rows refresh as
project files change via the `restore-keys` prefix fallback.

## Falling back to the full suite instead of building the map in-PR

If you'd rather never pay a map build inside a PR job, branch on
`affected --format json` — `mapReady: false` means the cache was cold:

```yaml
      - name: Select affected tests
        id: select
        run: |
          node .impact-cli/out/cli.js affected --base ${{ github.event.pull_request.base.sha }} --format json > affected.json
          echo "mapReady=$(jq -r .mapReady affected.json)" >> "$GITHUB_OUTPUT"

      - name: Run affected tests
        if: steps.select.outputs.mapReady == 'true'
        run: node .impact-cli/out/cli.js run --base ${{ github.event.pull_request.base.sha }} --ci

      - name: Full suite (cold map)
        if: steps.select.outputs.mapReady != 'true'
        run: dotnet test
```

and refresh the map on a schedule or on merge to main (`impact build-map
--refresh` under the same cache key).

The JSON shape: `{ "mapReady": bool, "classes": [FQNs], "projects":
[names run in full for unmapped files], "changedFiles": [repo-relative] }`.
Empty `classes` + `projects` with `mapReady: true` genuinely means nothing is
affected.

## Keep a full run somewhere

Affected selection is a bet on the map plus the fallback rules (see "Known
blind spots" in the README: reflection-by-name, config files, source
generators). Keep an unconditional `dotnet test` on merge to main or nightly
— impact narrows the inner loop; it doesn't replace the last line of defense.
