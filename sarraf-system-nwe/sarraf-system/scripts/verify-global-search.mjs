import fs from "node:fs";

// The search is the one screen that reads across everything, so it is the one place where a
// missing authorization check would leak the most. These are the contracts it must keep.
const original = fs.readFileSync("supabase/migrations/202608100004_global_command_search.sql", "utf8").toLowerCase();
const currentFile = fs.readFileSync("supabase/migrations/202608280014_search_that_finds_what_you_are_holding.sql", "utf8").toLowerCase();
// The comments quote the old code in order to explain what was wrong with it, so the checks
// below read the statements alone.
const current = currentFile.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
const ui = fs.readFileSync("src/components/operations/OperationalPalette.jsx", "utf8");

for (const token of ["security definer", "set search_path = pg_catalog, public", "auth.uid()", "result_limit", "revoke all", "grant execute"]) {
  if (!original.includes(token)) throw new Error(`Missing search security contract: ${token}`);
  if (!current.includes(token)) throw new Error(`The current search dropped a security contract: ${token}`);
}

// A SECURITY DEFINER function owned by the migration runner ignores every tenant policy, and this
// one reads six tables. Ownership is the whole basis for it being safe.
if (!current.includes("owner to sarraf_definer")) {
  throw new Error("the search runs as a role that can ignore row-level security");
}
// Within one business the policies do not separate two customers. This does.
if (!current.includes("staff or b.customer_id = actor.id")) {
  throw new Error("the search no longer limits a customer to their own receipts");
}
// What made it useless: a person reads out the END of a reference, not the beginning.
if (!current.includes("position(q in lower(coalesce(r.tracking_code, ''))) > 0")) {
  throw new Error("the search cannot find a receipt by the code its sender reads out");
}
if (current.includes("like query_prefix")) {
  throw new Error("the search is matching prefixes again; the tail of a code will not find it");
}

for (const token of ['role="dialog"', 'role="combobox"', 'aria-live="polite"', "event.metaKey", "event.ctrlKey", 'event.key === "Escape"']) {
  if (!ui.includes(token)) throw new Error(`Missing palette accessibility contract: ${token}`);
}
// The database answers with a key; the screen says it in the language that is on.
if (!ui.includes("kindLabel(lang, item.type)")) {
  throw new Error("the palette prints the database's own word for a result instead of translating it");
}
if (!ui.includes("onNavigate(item.path, item.focus")) {
  throw new Error("choosing a result no longer says which record it was about");
}

console.log("Global Search authorization, bounds, command safety, reach, and accessibility contracts passed.");
