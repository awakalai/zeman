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
  assert.ok(/#0D1014/.test(css), "the dark background was lost in the move");
});

test("the eight places that rendered it still can, and render nothing", () => {
  const src = app();
  assert.ok(/<Styles \/>/.test(src), "the call sites were edited — they were meant not to need it");
  assert.ok(/function Styles\(\) \{\s*return null;\s*\}/.test(src),
    "Styles renders something again");
});
