import assert from "node:assert/strict";
import test from "node:test";
import { plainPreview, previewProblem } from "../../scripts/timbre.ts";

test("plainPreview turns the simulateWriteContract Map into an object", () => {
  const plain = plainPreview(new Map<string, unknown>([
    ["ok", true],
    ["error", ""],
  ]));
  assert.equal(plain instanceof Map, false);
  assert.deepEqual(plain, { ok: true, error: "" });
  assert.equal(previewProblem(plain), null);
});

test("ok false after the Map conversion refuses the send", () => {
  const plain = plainPreview(new Map<string, unknown>([
    ["ok", false],
    ["error", "inbox is closed"],
  ]));
  assert.deepEqual(plain, { ok: false, error: "inbox is closed" });
  assert.equal(previewProblem(plain), "inbox is closed");
});

test("ok false with an empty error still refuses the send", () => {
  const plain = plainPreview(new Map<string, unknown>([
    ["ok", false],
    ["error", ""],
  ]));
  assert.equal(previewProblem(plain), "preview_send refused the message");
});
