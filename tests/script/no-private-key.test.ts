import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const scriptsDir = path.join(import.meta.dirname, "..", "..", "scripts");
const forbidden = [/PRIVATE_KEY/i, /--private-key/i];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

test("scripts/ does not contain PRIVATE_KEY or --private-key", () => {
  const found = files(scriptsDir);
  assert.ok(found.length > 0);
  for (const file of found) {
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${file} matches ${pattern}`);
    }
  }
});
