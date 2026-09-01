import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Nothing that looks like a credential may enter the source.
 *
 * Two live database passwords reached this project through a chat window earlier in its life.
 * They never entered a file, and nothing would have stopped them if they had: no gate looked.
 * A password committed once is a password in the history for ever, however fast it is deleted.
 *
 * verify:source now refuses four shapes. These drive the real gate against a real file, because
 * a pattern asserted against a string in a test proves the pattern and not the gate — and it is
 * the gate that has to be running.
 */

const root = path.resolve(import.meta.dirname, "..");
const runGate = () => {
  try {
    execFileSync("node", ["scripts/verify-source-contracts.mjs"], { cwd: root, encoding: "utf8" });
    return null;
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
};

// Written into the tracked tree, because that is what the gate walks, and removed afterwards
// whatever happens — a probe left behind would fail every later run for the wrong reason.
const withProbe = (contents, fn) => {
  const probe = path.join(root, "src", "__credential_probe_test.js");
  writeFileSync(probe, contents);
  try { return fn(); } finally { rmSync(probe, { force: true }); }
};

test("the gate passes on the source as it stands", () => {
  assert.equal(runGate(), null, "the repository already contains something the gate refuses");
});

test("a connection string carrying a password is refused", () => {
  const said = withProbe(
    'const url = "postgresql://postgres:notarealpassword@db.example.supabase.co:5432/postgres";\n',
    runGate);
  assert.ok(said, "a connection string with a password was accepted");
  assert.match(said, /connection string with a password/);
});

test("a JWT is refused — every Supabase key is one", () => {
  const said = withProbe(
    'const k = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiZXhhbXBsZSJ9.notarealsignature";\n',
    runGate);
  assert.ok(said, "a JWT was accepted");
  assert.match(said, /a JWT/);
});

test("a private key block is refused", () => {
  const said = withProbe("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n", runGate);
  assert.ok(said, "a private key was accepted");
  assert.match(said, /a private key/);
});

test("a secret assigned to a literal is refused", () => {
  const said = withProbe('const SUPABASE_SERVICE_ROLE_KEY = "abcdefghijklmnopqrst";\n', runGate);
  assert.ok(said, "a secret assigned to a literal was accepted");
  assert.match(said, /assigned to a literal/);
});

test("the refusal names the file and line, and does not print the secret", () => {
  const secret = "notarealpasswordxyz";
  const said = withProbe(`const url = "postgresql://postgres:${secret}@db.example.supabase.co:5432/postgres";\n`, runGate);
  assert.match(said, /__credential_probe_test\.js:1/, "the refusal does not say where");
  assert.ok(!said.includes(secret),
    "the refusal printed the credential — which puts it in the CI log, where it was not before");
});

test("the refusal says to rotate it, not only to remove it", () => {
  const said = withProbe('const k = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.notarealsignature";\n', runGate);
  assert.match(said, /rotate/i,
    "a credential that has been written down is compromised, and deleting the line does not undo that");
});

test("an ordinary environment-variable read is not mistaken for a secret", () => {
  // The shape the whole codebase uses. A gate that refused this would be turned off within a day.
  const said = withProbe(
    'const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";\n',
    runGate);
  assert.equal(said, null, "reading a secret from the environment was refused");
});

test("nor is a comment that talks about connection strings", () => {
  const said = withProbe(
    "// The connection string looks like postgresql://user:PASSWORD@host — never write one here.\n"
    + "const url = process.env.SUPABASE_DB_URL || '';\n",
    runGate);
  assert.equal(said, null, "a comment describing the shape was treated as the shape");
});
