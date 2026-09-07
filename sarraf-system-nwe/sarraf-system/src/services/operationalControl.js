export const SEARCH_LIMIT = 20;
export function safeCommand(command) {
  return command && command.kind === "navigation" && typeof command.path === "string" && /^#\/[^?#]+$/.test(command.path);
}

export function safeInboxAction(item) {
  const action = item?.action || (item?.path ? { kind: "navigation", path: item.path } : null);
  return safeCommand(action) ? action : null;
}

export const SEARCH_GROUPS = Object.freeze([
  "Command", "customer", "partner", "transaction", "receipt", "intake", "batch", "currency",
]);

export function groupSearchResults(results = []) {
  return SEARCH_GROUPS
    .map((type) => ({ type, results: results.filter((item) => item?.type === type) }))
    .filter((group) => group.results.length);
}

export async function operationalSearch(client, query, { cursor = null, limit = SEARCH_LIMIT } = {}) {
  const q = String(query || "").normalize("NFKC").trim().slice(0, 80);
  if (q.length < 2) return { results: [], nextCursor: null };
  const bounded = Math.min(SEARCH_LIMIT, Math.max(1, Number(limit) || SEARCH_LIMIT));
  const { data, error } = await client.rpc("sarraf_operational_search", { p_query: q, p_limit: bounded, p_cursor: cursor });
  if (error) throw error;
  return { results: data || [], nextCursor: data?.length === bounded ? data.at(-1)?.cursor || null : null };
}

export const OPERATIONAL_CENTER_LIMIT = 80;

async function loadOperationalCenter(client, rpc, limit = OPERATIONAL_CENTER_LIMIT) {
  const bounded = Math.min(100, Math.max(1, Number(limit) || OPERATIONAL_CENTER_LIMIT));
  const { data, error } = await client.rpc(rpc, { p_limit: bounded });
  if (error) throw error;
  const payload = data && typeof data === "object" ? data : {};
  return {
    ...payload,
    total: Math.min(bounded, Math.max(0, Number(payload.total) || 0)),
    counts: payload.counts && typeof payload.counts === "object" ? payload.counts : {},
    items: Array.isArray(payload.items) ? payload.items.slice(0, bounded) : [],
  };
}

export function loadActionInbox(client, options = {}) {
  return loadOperationalCenter(client, "sarraf_action_inbox_v3", options.limit);
}

export function loadIntegrityCenter(client, options = {}) {
  return loadOperationalCenter(client, "sarraf_integrity_center_v2", options.limit);
}
