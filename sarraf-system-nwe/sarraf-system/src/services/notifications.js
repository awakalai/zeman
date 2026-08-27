/**
 * The inbox.
 *
 * «سیستەمی ئاگادارکردنەوە (Notifications): لە کاتی وەرگرتن، ڕەتکردنەوە، یان پەسەندکردنی فیش،
 *   ئاگادارکردنەوەی زووی (Real-time Notification) بۆ هەردولا بڕوات.»
 *
 * The rows are written by database triggers — a browser has no insert on the table at all — so
 * everything here reads and marks read, and nothing here can invent a notification. What arrives
 * arrives because something actually happened to a receipt.
 *
 * Realtime is a courtesy, not the mechanism. If the socket never connects, or the publication is
 * not enabled on this project, the list still refreshes when the screen is opened or comes back
 * into view; the caller decides how often. A notification that arrives a minute late is a
 * notification; one that is never written is not.
 */

export const NOTIFICATION_KINDS = [
  "receipt_received", "receipt_accepted", "receipt_rejected", "receipt_replaced", "batch_arrived",
];

const mapRow = (r) => ({
  id: r.id,
  kind: r.kind,
  title: r.title || "",
  body: r.body || "",
  subjectKind: r.subject_kind || "receipt",
  subjectId: r.subject_id || null,
  actorId: r.actor_id || null,
  createdAt: r.created_at || null,
  readAt: r.read_at || null,
  unread: !r.read_at,
});

/** The most recent notifications for whoever is signed in. Their own and nobody else's. */
export async function loadNotifications(client, { limit = 40 } = {}) {
  const { data, error } = await client
    .from("zeman_notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 40, 1), 200));
  if (error) throw error;
  return (data || []).map(mapRow);
}

/** Mark one as read. The policy allows a person to update only their own rows. */
export async function markNotificationRead(client, id) {
  if (!id) return;
  const { error } = await client
    .from("zeman_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);
  if (error) throw error;
}

/** Mark every unread one read, in one statement. */
export async function markAllNotificationsRead(client) {
  const { error } = await client
    .from("zeman_notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  if (error) throw error;
}

/**
 * Hear new ones as they are written.
 *
 * Returns an unsubscribe function, always — including when realtime is unavailable on this
 * client, so a caller never has to ask whether it worked before cleaning up.
 */
export function subscribeToNotifications(client, onArrive) {
  if (typeof client?.channel !== "function") return () => {};
  let channel = null;
  try {
    channel = client
      .channel("zeman-notifications")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "zeman_notifications" },
        (payload) => { try { onArrive(mapRow(payload?.new || {})); } catch { /* a bad row is not worth a crash */ } })
      .subscribe();
  } catch {
    return () => {};
  }
  return () => {
    try { client.removeChannel?.(channel); } catch { /* already gone */ }
  };
}

/** What each kind is, in one word, for a screen that groups them. */
export function notificationTone(kind) {
  if (kind === "receipt_rejected") return "red";
  if (kind === "receipt_accepted") return "green";
  if (kind === "receipt_replaced") return "amber";
  return "blue";
}
