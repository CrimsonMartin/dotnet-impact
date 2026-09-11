// Before/after table for two bench result files.
// Usage: node bench/compare.mjs <before.json> <after.json>
import * as fs from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: node bench/compare.mjs <before.json> <after.json>");
  process.exit(2);
}
const a = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const b = JSON.parse(fs.readFileSync(afterPath, "utf8"));

const rows = [];
for (const [k, v] of Object.entries(a.ops)) {
  const w = b.ops[k];
  if (!w) continue;
  const d = w.steady_median_ms - v.steady_median_ms;
  const pct = v.steady_median_ms > 0 ? (d / v.steady_median_ms) * 100 : 0;
  rows.push([k, v.steady_median_ms, w.steady_median_ms, d, pct]);
}
const ea = a.edit_cycle.steady_median_ms ?? a.edit_cycle.cold_median_ms;
const eb = b.edit_cycle.steady_median_ms ?? b.edit_cycle.cold_median_ms;
if (ea && eb) rows.push(["edit_cycle", ea, eb, eb - ea, ((eb - ea) / ea) * 100]);

console.log(`${a.label} (${a.git}) -> ${b.label} (${b.git})`);
console.log(`fixture: ${a.fixture.projects} projects / ${a.fixture.coreClasses} core classes   vs   ${b.fixture.projects} / ${b.fixture.coreClasses}`);
console.log("");
const fmt = (n) => String(Math.round(n)).padStart(9);
console.log(`operation          before(ms)  after(ms)   delta(ms)    delta(%)   verdict`);
for (const [name, av, bv, d, pct] of rows) {
  const verdict = Math.abs(pct) < 3 ? "noise" : pct < 0 ? "Faster" : "SLOWER";
  console.log(`${name.padEnd(16)} ${fmt(av)}  ${fmt(bv)}  ${String(Math.round(d)).padStart(9)}  ${pct.toFixed(1).padStart(8)}%   ${verdict}`);
}
console.log("");
console.log(`edit fastpath hits per pass: ${a.edit_cycle.hits.join("/")} -> ${b.edit_cycle.hits.join("/")}`);
console.log(`edit ok counts:     ${a.edit_cycle.ok.join("/")} -> ${b.edit_cycle.ok.join("/")}`);
