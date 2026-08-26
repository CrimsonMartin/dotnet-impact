import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { locateClasses, locateMethod } from "../core/locate";

const FILE_SCOPED = `using Xunit;

namespace My.App.Tests;

public class CalcTests
{
    [Fact]
    public void Adds() { }

    [Theory]
    [InlineData(1)]
    public void Divides(int x) { }
}
`;

const BLOCK_SCOPED = `namespace Legacy.Tests
{
    internal sealed partial class OldTests
    {
        public void Runs() { }
    }
}
`;

function scaffold(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impact-locate-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test("locateClasses: file-scoped and block namespaces, modifiers, attributes", () => {
  const dir = scaffold({ "CalcTests.cs": FILE_SCOPED, "OldTests.cs": BLOCK_SCOPED });
  const found = locateClasses(dir);
  const calc = found.get("My.App.Tests.CalcTests");
  assert.ok(calc);
  assert.equal(path.basename(calc.file), "CalcTests.cs");
  assert.equal(calc.line, 4);
  assert.ok(found.get("Legacy.Tests.OldTests"));
});

test("locateMethod: finds declaration lines", () => {
  const dir = scaffold({ "CalcTests.cs": FILE_SCOPED });
  const file = path.join(dir, "CalcTests.cs");
  assert.equal(locateMethod(file, "Adds"), 7);
  assert.equal(locateMethod(file, "Divides"), 11);
  assert.equal(locateMethod(file, "Missing"), undefined);
});
