#!/usr/bin/env node
/**
 * A name used but never declared.
 *
 * `if (!transactionId) return flash(...)` sat at the top of the receipt uploader. transactionId
 * was not a prop of that component, not a state, and not declared anywhere in the file. It was a
 * free variable, so the line threw ReferenceError the instant anybody chose an image — and threw
 * it inside an event handler, where nothing catches it. No message, no rows, no error on the
 * screen. Receipt upload was dead for every role and the application looked fine.
 *
 * Nothing here could have caught it. The build does not resolve identifiers; the tests import
 * modules but never run that component; the business-flow gate drives the database directly. So
 * the one class of fault that produces silence rather than a failure was the one class nothing
 * looked for.
 *
 * This is what a linter's no-undef rule does, and there is no linter here. Rather than add one
 * and its configuration, this walks the source with the parser the bundler already ships and
 * reports every identifier that is read but never bound — by file, by line, by name.
 *
 *   npm run verify:names
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { transformSync } from "esbuild";
import * as acorn from "acorn";

const root = path.resolve(import.meta.dirname, "..");
const roots = ["src", "api", "scripts"];

// Names that exist without being declared in the file that uses them.
const AMBIENT = new Set([
  // JavaScript itself
  "globalThis", "console", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean",
  "Date", "RegExp", "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "Promise", "Symbol", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect", "BigInt",
  "Intl", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "structuredClone", "queueMicrotask",
  "undefined", "NaN", "Infinity", "arguments", "eval",
  // Browser
  "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage",
  "fetch", "Headers", "Request", "Response", "FormData", "Blob", "File", "FileReader",
  "URL", "URLSearchParams", "AbortController", "Image", "Audio", "atob", "btoa",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "cancelAnimationFrame", "matchMedia", "getComputedStyle", "alert", "confirm", "prompt",
  "crypto", "performance", "screen", "CustomEvent", "Event", "MutationObserver",
  "IntersectionObserver", "ResizeObserver", "TextEncoder", "TextDecoder", "Notification",
  "IDBKeyRange", "indexedDB", "caches", "self", "postMessage", "addEventListener",
  "removeEventListener", "OffscreenCanvas", "createImageBitmap", "Worker", "BroadcastChannel",
  // Node
  "process", "Buffer", "__dirname", "__filename", "require", "module", "exports",
  "URLPattern", "AbortSignal", "TransformStream", "ReadableStream", "WritableStream",
  // Typed arrays and binary helpers, used for hashing and file bytes.
  "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array",
  "Float32Array", "Float64Array", "ArrayBuffer", "DataView", "SharedArrayBuffer",
]);

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(js|jsx|mjs)$/.test(entry)) files.push(full);
  }
};
for (const r of roots) {
  const dir = path.join(root, r);
  try { walk(dir); } catch {}
}

// Every binding a scope introduces, walked outward from the use.
const declaredIn = (node) => {
  const names = [];
  const fromPattern = (p) => {
    if (!p) return;
    if (p.type === "Identifier") names.push(p.name);
    else if (p.type === "ObjectPattern") p.properties.forEach((q) =>
      fromPattern(q.type === "RestElement" ? q.argument : q.value));
    else if (p.type === "ArrayPattern") p.elements.forEach(fromPattern);
    else if (p.type === "AssignmentPattern") fromPattern(p.left);
    else if (p.type === "RestElement") fromPattern(p.argument);
  };
  if (node.type === "VariableDeclaration") node.declarations.forEach((d) => fromPattern(d.id));
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression"
      || node.type === "ArrowFunctionExpression") {
    if (node.id) names.push(node.id.name);
    node.params.forEach(fromPattern);
  }
  if (node.type === "ClassDeclaration" && node.id) names.push(node.id.name);
  if (node.type === "CatchClause") fromPattern(node.param);
  if (node.type === "ImportDeclaration") node.specifiers.forEach((s) => names.push(s.local.name));
  return names;
};

const problems = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  let code;
  try {
    // jsx: "automatic", as @vitejs/plugin-react compiles it. esbuild's default injects
    // React.createElement, which made every component that does not import React — correctly,
    // under the modern runtime — look as though it used an undeclared name.
    code = transformSync(source, {
      loader: file.endsWith(".jsx") ? "jsx" : "js", format: "esm", jsx: "automatic",
    }).code;
  } catch (e) {
    problems.push({ file, line: 0, name: `could not be parsed: ${String(e.message).slice(0, 120)}` });
    continue;
  }
  let tree;
  try {
    tree = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (e) {
    problems.push({ file, line: 0, name: `could not be parsed: ${String(e.message).slice(0, 120)}` });
    continue;
  }

  // One pass collecting every binding anywhere in the file, and every identifier read. A name
  // declared in one function and read in another is not this bug; a name declared nowhere is.
  const bound = new Set();
  const read = [];
  const visit = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    declaredIn(node).forEach((n) => bound.add(n));
    if (node.type === "Identifier" && parent) {
      // A method's name is not a reference to anything. Missing these reported `constructor`,
      // `has` and `size` as undeclared in every class in the repository.
      const isKey = (parent.type === "Property" || parent.type === "MethodDefinition"
                     || parent.type === "PropertyDefinition")
        && parent.key === node && !parent.computed;
      const isMember = parent.type === "MemberExpression" && parent.property === node && !parent.computed;
      const isLabel = parent.type === "LabeledStatement" || parent.type === "BreakStatement"
        || parent.type === "ContinueStatement";
      const isMeta = parent.type === "MetaProperty";
      const isExportName = parent.type === "ExportSpecifier" && parent.exported === node;
      const isImportName = parent.type === "ImportSpecifier" && parent.imported === node;
      if (!isKey && !isMember && !isLabel && !isMeta && !isExportName && !isImportName) {
        read.push({ name: node.name, line: node.loc.start.line });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => visit(c, node));
      else if (child && typeof child.type === "string") visit(child, node);
    }
  };
  visit(tree, null);

  const seen = new Set();
  for (const { name, line } of read) {
    if (bound.has(name) || AMBIENT.has(name) || seen.has(name)) continue;
    seen.add(name);
    problems.push({ file: path.relative(root, file), line, name });
  }
}

if (problems.length === 0) {
  console.log(`Every name is declared, across ${files.length} files.`);
  process.exit(0);
}
for (const p of problems) {
  console.log(`FAIL  ${p.file}${p.line ? `:${p.line}` : ""}  ${p.name}`);
}
console.log(`\n${problems.length} name(s) are used but never declared.`);
process.exit(1);
