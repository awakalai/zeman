// One rule about who may touch whose data, written once.
//
// Four routes hold the service key, which means PostgREST applies no row level security to
// anything they read or write. Every tenant boundary those routes are supposed to respect has
// to be enforced here, in JavaScript, because the database has been told to trust them.
//
// The rule is the same everywhere and has three parts:
//
//   · an actor with no business may not touch a row that belongs to one — a manager acting
//     without an explicit support context is exactly this case, and must be refused;
//   · an actor with a business may touch only rows of that business;
//   · a refusal must not say which of the two it was. "This row belongs to somebody else" and
//     "this row does not exist" have to read identically, or the refusal itself becomes a way
//     to enumerate another business's records.
//
// A row with no tenant at all is refused for everybody. There should be none — the live
// baseline records zero across every financial and receipt table — and the day one appears it
// must be invisible rather than universally visible.

// Every actor lookup must ask for the tenant, or the check below silently passes everything.
export const ACTOR_COLUMNS = "id,role,deleted,tenant_id,admin_level";

export const isTenantless = (actor) => !actor || !actor.tenant_id;

// True only when both sides name the same business.
export function sameTenant(actor, row) {
  const mine = actor?.tenant_id || null;
  const theirs = row?.tenant_id || null;
  if (!mine || !theirs) return false;
  return mine === theirs;
}

// Adds the tenant predicate to a PostgREST query so a write cannot land on another business's
// row even if the check above were somehow reached with the wrong actor. Called without a
// business it refuses rather than widening: a query with no tenant predicate is the bug.
export function withinTenant(query, tenantId) {
  if (!tenantId) throw new Error("withinTenant called without a business");
  return query.eq("tenant_id", tenantId);
}

// The one refusal these routes are allowed to give about somebody else's row.
export function notFound(what = "receipt") {
  const error = new Error(`${what} not found`);
  Object.assign(error, {
    status: 404,
    code: `${what}_not_found`,
    retryable: false,
    outcomeKnown: true,
  });
  return error;
}
