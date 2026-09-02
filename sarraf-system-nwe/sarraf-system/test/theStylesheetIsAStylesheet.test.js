import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Seven hundred lines of CSS lived inside App.jsx as a template literal returned by a component,
 * so the browser received them as JavaScript: parsed by the JS engine rather than the CSS one,
 * re-sent whenever anything in the application changed, and unable to begin loading until the
 * script did.
 *
 * Not one line was ever dynamic. It was a stylesheet wearing a component's clothes.
 */

const app = () => readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const sheet = () => readFileSync(new URL("../src/styles/zeman.css", import.meta.url), "utf8");

test("the stylesheet is a stylesheet, not a string inside a component", () => {
  assert.ok(!/return <style>/.test(app()),
    "App.jsx returns a <style> element again — the CSS is back inside the JavaScript bundle");
});

test("and it is loaded once, at start-up", () => {
  const main = readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
  assert.ok(/import "\.\/styles\/zeman\.css";/.test(main), "nothing imports the stylesheet");
});

test("nothing in it depends on anything the application knows", () => {
  // The moment one `${…}` appears, this file cannot be a stylesheet any more, and somebody
  // will move the whole thing back rather than find the one line that needed to be dynamic.
  const dynamic = sheet().match(/\$\{[^}]*\}/g) || [];
  assert.deepEqual(dynamic, [], "the stylesheet has grown an interpolation");
});

test("the design tokens and both themes survived the move", () => {
  const css = sheet();
  for (const token of ["--ac:", "--bg:", "--surf:", "--txt:", "--pos:", "--neg:", "--warn:"]) {
    assert.ok(css.includes(token), `a design token was lost in the move: ${token}`);
  }
  assert.ok(/\[data-theme="dark"\]/.test(css), "the dark theme was lost in the move");
  // Structure, not one hex. This used to pin #0D1014 — a value from the FIRST of two :root
  // blocks, which the second was silently overriding, so the test was guarding a colour nobody
  // had ever seen on screen. A palette is allowed to change; what must not vanish is the dark
  // theme having its own paper.
  const dark = css.slice(css.indexOf('[data-theme="dark"]'));
  assert.match(dark.slice(0, 600), /--bg\s*:\s*#[0-9A-Fa-f]{6}/,
    "the dark theme no longer sets its own background");
});

// One palette, and only one. Two :root blocks meant twenty-three tokens decided twice and the
// first answer thrown away — a product that feels unconsidered for a reason invisible in every
// screenshot. verify:source enforces this too; here it is cheap enough to ask on every run.
test("the palette is declared once", () => {
  const css = sheet();
  assert.equal((css.match(/^:root/gm) || []).length, 1, "a second palette overrides the first");
  assert.equal((css.match(/^\[data-theme="dark"\]\s*\{/gm) || []).length, 1,
    "a second dark palette overrides the first");
});

test("the eight places that rendered it still can, and render nothing", () => {
  const src = app();
  assert.ok(/<Styles \/>/.test(src), "the call sites were edited — they were meant not to need it");
  assert.ok(/function Styles\(\) \{\s*return null;\s*\}/.test(src),
    "Styles renders something again");
});
