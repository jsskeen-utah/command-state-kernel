import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesGlob, matchTemplate, parseRef } from "../src/uri.ts";

test("* matches exactly one segment", () => {
  assert.equal(matchesGlob("command:/doc/update", "command:/doc/*"), true);
  assert.equal(matchesGlob("command:/doc/a/b", "command:/doc/*"), false);
});

test("** matches zero or more segments", () => {
  assert.equal(matchesGlob("command:/doc", "command:/doc/**"), true);
  assert.equal(matchesGlob("command:/doc/a/b", "command:/doc/**"), true);
  assert.equal(matchesGlob("command:/other/a", "command:/doc/**"), false);
});

test("a glob never matches across schemes", () => {
  assert.equal(matchesGlob("state:/doc/a", "command:/**"), false);
  assert.equal(matchesGlob("command:/doc/a", "state:/**"), false);
});

test("relative references resolve against the focus path and normalize", () => {
  const ref = parseRef("command:./update/../save", "command", "/doc");
  assert.deepEqual(ref, { ok: true, scheme: "command", uri: "command:/doc/save", segments: ["doc", "save"] });
});

test("references above the root are rejected", () => {
  assert.equal(parseRef("command:../x", "command", "/").ok, false);
});

test("non-kebab segments are rejected", () => {
  assert.equal(parseRef("command:/Doc/x", "command").ok, false);
  assert.equal(parseRef("command:/doc/update_content", "command").ok, false);
});

test("authority syntax is rejected", () => {
  assert.equal(parseRef("command://doc/x", "command").ok, false);
});

test("template segments are accepted only when templates are enabled", () => {
  assert.equal(parseRef("state:/doc/:id", "state").ok, false);
  const ref = parseRef("state:/doc/:id", "state", "/", { templates: true });
  assert.equal(ref.ok && ref.uri, "state:/doc/:id");
});

test("templates extract parameters and reject mismatched lengths", () => {
  assert.deepEqual(matchTemplate(["doc", ":id"], ["doc", "d1"]), { id: "d1" });
  assert.equal(matchTemplate(["doc", ":id"], ["doc"]), undefined);
  assert.equal(matchTemplate(["doc", ":id"], ["note", "d1"]), undefined);
});
