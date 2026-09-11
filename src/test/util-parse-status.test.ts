import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatusZ } from "../core/util";

/**
 * Helper: format a single entry as git porcelain -z outputs it.
 * The actual git format is: "<XY><SP><file>\0" (status+file in one NUL-chunk).
 * For rename/copy: "<XY><SP><dest>\0<origin>\0" (two NUL-chunks).
 */
function entry(status2: string, file: string): string {
  // git status -z format: exactly 2 status chars + space + path. Pad single-
  // char statuses (X + " ") like git does.
  return `${status2.padEnd(2, " ")} ${file}\0`;
}

function renameEntry(from: string, to: string): string {
  // Rename: first chunk = "R  to\0", second chunk = "from\0"
  return `R  ${to}\0${from}\0`;
}

function copyEntry(from: string, to: string): string {
  return `C  ${to}\0${from}\0`;
}

/* ----------------------------------------------------------- */
/*  parseStatusZ — empty and malformed input                   */
/* ----------------------------------------------------------- */

test("parseStatusZ: empty string returns empty array", () => {
  assert.deepEqual(parseStatusZ(""), []);
});

test("parseStatusZ: single NUL returns empty array", () => {
  assert.deepEqual(parseStatusZ("\0"), []);
});

test("parseStatusZ: status chunk shorter than 4 chars is skipped", () => {
  // "M " alone, "M " (3 chars), etc. are all < 4 chars and skipped
  assert.deepEqual(parseStatusZ("M"), []);
  assert.deepEqual(parseStatusZ("M "), []);
  assert.deepEqual(parseStatusZ("M \0"), []);
});

test("parseStatusZ: empty NUL-separated chunks are skipped", () => {
  assert.deepEqual(parseStatusZ("\0\0\0"), []);
  // Empty chunks (trailing/doubled NULs) produce no entries; the one real
  // entry still parses.
  const out = parseStatusZ(entry("M", "a") + "\0" + entry("A", "b"));
  assert.equal(out.length, 2);
  assert.equal(out[0].file, "a");
  assert.equal(out[1].file, "b");
});

/* ----------------------------------------------------------- */
/*  parseStatusZ — all standard status codes                   */
/* ----------------------------------------------------------- */

test("parseStatusZ: handles all standard XY status codes", () => {
  const out = parseStatusZ(
    entry("M", "src/modified.cs") +
    entry("A", "src/added.cs") +
    entry("D", "src/deleted.cs") +
    entry("M", "src/another.cs") +
    entry("??", "src/untracked.cs")
  );
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], { status: "M ", file: "src/modified.cs", origin: undefined });
  assert.deepEqual(out[1], { status: "A ", file: "src/added.cs", origin: undefined });
  assert.deepEqual(out[2], { status: "D ", file: "src/deleted.cs", origin: undefined });
  assert.deepEqual(out[3], { status: "M ", file: "src/another.cs", origin: undefined });
  assert.deepEqual(out[4], { status: "??", file: "src/untracked.cs", origin: undefined });
});

test("parseStatusZ: handles U (up-to-date) status", () => {
  const out = parseStatusZ(entry("U", "src/uptodate.cs"));
  assert.deepEqual(out, [{ status: "U ", file: "src/uptodate.cs", origin: undefined }]);
});

test("parseStatusZ: handles conflict status codes (UU, AU, UA, etc.)", () => {
  const out = parseStatusZ(entry("UU", "src/conflict.cs"));
  assert.deepEqual(out, [{ status: "UU", file: "src/conflict.cs", origin: undefined }]);
});

/* ----------------------------------------------------------- */
/*  parseStatusZ — rename and copy records                     */
/* ----------------------------------------------------------- */

test("parseStatusZ: rename record includes origin path", () => {
  const out = parseStatusZ(renameEntry("src/old.cs", "src/new.cs"));
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "R ");
  assert.equal(out[0].file, "src/new.cs");
  assert.equal(out[0].origin, "src/old.cs");
});

test("parseStatusZ: copy record includes origin path", () => {
  const out = parseStatusZ(copyEntry("src/orig.cs", "src/copy.cs"));
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "C ");
  assert.equal(out[0].file, "src/copy.cs");
  assert.equal(out[0].origin, "src/orig.cs");
});

test("parseStatusZ: the XY field is exactly 2 chars (scores come from diff, not status)", () => {
  // `git status --porcelain` never emits similarity scores (that's `git diff
  // --name-status`); the status field is always 2 chars. A malformed 4-char
  // prefix parses as the first 2 chars + the rest lands in the file field.
  const out = parseStatusZ("R100 src/new.cs\0src/old.cs\0");
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "R1");
  assert.equal(out[0].origin, "src/old.cs");
});

test("parseStatusZ: rename with origin that has spaces", () => {
  const out = parseStatusZ(renameEntry("src/my old file.cs", "src/my new file.cs"));
  assert.equal(out.length, 1);
  assert.equal(out[0].origin, "src/my old file.cs");
  assert.equal(out[0].file, "src/my new file.cs");
});

test("parseStatusZ: rename with origin that has special chars", () => {
  const out = parseStatusZ(renameEntry("src/[special].cs", "src/[new].cs"));
  assert.equal(out.length, 1);
  assert.equal(out[0].origin, "src/[special].cs");
  assert.equal(out[0].file, "src/[new].cs");
});

test("parseStatusZ: multiple renames in sequence", () => {
  const out = parseStatusZ(
    renameEntry("a.cs", "b.cs") +
    renameEntry("b.cs", "c.cs") +
    renameEntry("c.cs", "d.cs")
  );
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { status: "R ", file: "b.cs", origin: "a.cs" });
  assert.deepEqual(out[1], { status: "R ", file: "c.cs", origin: "b.cs" });
  assert.deepEqual(out[2], { status: "R ", file: "d.cs", origin: "c.cs" });
});

/* ----------------------------------------------------------- */
/*  parseStatusZ — mixed records                               */
/* ----------------------------------------------------------- */

test("parseStatusZ: mixed modify/add/delete/renamed", () => {
  const out = parseStatusZ(
    entry("M", "src/A.cs") +
    entry("A", "src/B.cs") +
    entry("D", "src/C.cs") +
    renameEntry("src/old.cs", "src/new.cs")
  );
  assert.equal(out.length, 4);
  assert.equal(out[0].origin, undefined);
  assert.equal(out[1].origin, undefined);
  assert.equal(out[2].origin, undefined);
  assert.equal(out[3].origin, "src/old.cs");
});

test("parseStatusZ: untracked files never have origin", () => {
  const out = parseStatusZ(entry("??", "src/new.cs"));
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "??");
  assert.equal(out[0].origin, undefined);
});

test("parseStatusZ: ignored files never have origin", () => {
  const out = parseStatusZ(entry("!", "src/ignored.cs"));
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "! ");
  assert.equal(out[0].origin, undefined);
});

/* ----------------------------------------------------------- */
/*  parseStatusZ — edge cases                                  */
/* ----------------------------------------------------------- */

test("parseStatusZ: trailing NUL does not create a phantom entry", () => {
  const out = parseStatusZ(entry("M", "src/a.cs"));
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "src/a.cs");
});

test("parseStatusZ: consecutive NULs between entries are harmless", () => {
  const out = parseStatusZ(entry("M", "src/a.cs") + "\0" + entry("A", "src/b.cs"));
  assert.equal(out.length, 2);
  assert.equal(out[0].file, "src/a.cs");
  assert.equal(out[1].file, "src/b.cs");
});

test("parseStatusZ: rename followed by a non-renamed entry", () => {
  const out = parseStatusZ(
    renameEntry("old.cs", "new.cs") +
    entry("M", "other.cs")
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].origin, "old.cs");
  assert.equal(out[0].file, "new.cs");
  assert.equal(out[1].origin, undefined);
  assert.equal(out[1].file, "other.cs");
});

test("parseStatusZ: rename without origin chunk degrades to a plain entry", () => {
  // Malformed input (real git always pairs R with an origin chunk): the
  // missing origin chunk is empty → origin undefined, entry still kept.
  const out = parseStatusZ("R  src/new.cs\0");
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "R ");
  assert.equal(out[0].file, "src/new.cs");
  assert.equal(out[0].origin, undefined);
});

test("parseStatusZ: modified-in-index-and-worktree (MM) parses normally", () => {
  // git always separates the 2-char status from the path with a space.
  const out = parseStatusZ("MM src/a.cs\0");
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "MM");
  assert.equal(out[0].file, "src/a.cs");
});

test("parseStatusZ: a status chunk with no path (length < 4) is skipped", () => {
  // "M " + nothing is 3 chars: below the minimum, treated as a blank chunk.
  const out = parseStatusZ("M \0");
  assert.deepEqual(out, []);
});

test("parseStatusZ: file path with only whitespace in the path portion", () => {
  // A file named just spaces — unlikely but possible
  const out = parseStatusZ("M    \0");
  // "M " is status, "  " (2 chars) is file — passes the length check
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { status: "M ", file: "  ", origin: undefined });
});
