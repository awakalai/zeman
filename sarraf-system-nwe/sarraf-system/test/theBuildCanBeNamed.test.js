import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isStale, shortBuild } from "../src/services/buildVersion.js";

/**
 * Every fix shipped on the morning of 27 August was invisible on the owner's phone.
 *
 * The code was on the server. The screen kept showing sentences that no longer existed anywhere
 * in the source — one of them a wrong explanation I had written and already deleted. Three
 * screenshots were sent, three diagnoses were made, and all three were of behaviour that had been
 * fixed hours earlier. Neither the owner nor anybody reading over their shoulder could tell which
 * of the two builds they were looking at.
 *
 * A build nobody can name is a build nobody can confirm.
 */
const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const config = readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");

test("the build writes its own name into the bundle and into a file", () => {
  assert.match(config, /define:\s*\{\s*__BUILD_ID__/, "the bundle does not know which build it is");
  assert.match(config, /fileName: "version\.json"/, "no file the running app can compare itself against");
});

test("a newer build on the server is a stale page, and nothing else is", () => {
  assert.equal(isStale("20260827T090000", "20260827T083929"), true);
  assert.equal(isStale("20260827T083929", "20260827T083929"), false);
  // Offline, or a server that cannot answer, is not a reason to tell somebody they are out of date.
  assert.equal(isStale(null, "20260827T083929"), false);
  // Vite serving locally is never stale.
  assert.equal(isStale("20260827T090000", "dev"), false);
});

test("the name is short enough to read aloud from a screenshot", () => {
  const short = shortBuild("20260827T083929");
  assert.ok(short.length <= 12, `"${short}" is too long to quote`);
  assert.match(short, /0827/);
});

test("the screen says which build it is, and offers the newer one", () => {
  assert.match(source, /<BuildStamp \/>/, "no build is shown anywhere on the screen");
  assert.match(source, /<UpdateBanner lang=\{lang\} \/>/, "nothing tells the user a newer build exists");
});
