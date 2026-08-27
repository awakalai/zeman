import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import {
  loadNotifications, markAllNotificationsRead, markNotificationRead,
  notificationTone, subscribeToNotifications,
} from "../../services/notifications";

/**
 * «ئاگادارکردنەوەی زووی (Real-time Notification) بۆ هەردولا بڕوات»
 *
 * One bell, both sides of the receipt. The owner hears that a batch has arrived; the person who
 * sent it hears that it was accepted, or refused and why. The rows are written by the database
 * itself when the receipt actually moves, so what this shows is what happened rather than what a
 * screen believed happened.
 *
 * Three ways in, because one is not enough on a phone: the socket when it is connected, a
 * refresh whenever the app comes back to the foreground, and a slow poll behind both. An
 * installed PWA can sit in the background for a day with its socket long since dropped, and the
 * first thing the owner does is bring it forward.
 */

const TONE_COLOR = {
  red: "var(--neg)",
  green: "var(--pos)",
  amber: "var(--warn, #d08700)",
  blue: "var(--txt-2)",
};

const when = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return "ئێستا";
  if (minutes < 60) return `${minutes} خولەک`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} کاتژمێر`;
  return d.toLocaleDateString("en-GB");
};

export function NotificationBell({ client, enabled = true }) {
  const [items, setItems] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!client || !enabled) return;
    try {
      setItems(await loadNotifications(client));
      setError("");
    } catch (e) {
      // A failure to read the inbox must never take a screen down with it, and must not be
      // silent either: an empty bell and a broken bell look identical otherwise.
      setError(e?.message || "ئاگادارکردنەوەکان بار نەبوون");
    }
  }, [client, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const stop = subscribeToNotifications(client, (row) => {
      setItems((prev) => (prev || []).some((x) => x.id === row.id) ? prev : [row, ...(prev || [])]);
    });
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 2 * 60 * 1000);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [client, enabled, refresh]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const escape = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!enabled) return null;

  const unread = (items || []).filter((x) => x.unread).length;

  const openOne = async (item) => {
    if (!item.unread) return;
    setItems((prev) => (prev || []).map((x) => (x.id === item.id ? { ...x, unread: false, readAt: new Date().toISOString() } : x)));
    try { await markNotificationRead(client, item.id); } catch { refresh(); }
  };

  const clearAll = async () => {
    setItems((prev) => (prev || []).map((x) => ({ ...x, unread: false })));
    try { await markAllNotificationsRead(client); } catch { refresh(); }
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `${unread} ئاگادارکردنەوەی نەخوێندراوە` : "ئاگادارکردنەوەکان"}
        aria-expanded={open}
        className="relative w-9 h-9 rounded-[var(--r-sm)] flex items-center justify-center tap"
        style={{ background: "var(--surf-2)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
        <Bell className="w-[17px] h-[17px]" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full text-[10px] font-bold
                           flex items-center justify-center"
                style={{ background: "var(--neg)", color: "#fff" }}>
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-[300px] max-h-[420px] overflow-auto rounded-[var(--r-md)] shadow-lg"
             style={{ background: "var(--surf)", border: "1px solid var(--line)", insetInlineEnd: 0 }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--line)]">
            <div className="text-[12px] font-bold">ئاگادارکردنەوەکان</div>
            {unread > 0 && (
              <button onClick={clearAll} className="text-[11px] underline text-[var(--txt-3)] tap">
                هەمووی خوێندرایەوە
              </button>
            )}
          </div>

          {error && <div className="px-3 py-3 text-[11px]" style={{ color: "var(--neg)" }}>{error}</div>}
          {!error && items && !items.length && (
            <div className="px-3 py-6 text-[12px] text-center text-[var(--txt-3)]">هیچ ئاگادارکردنەوەیەک نییە</div>
          )}
          {!error && !items && (
            <div className="px-3 py-6 text-[12px] text-center text-[var(--txt-3)]">بارکردن...</div>
          )}

          {(items || []).map((item) => (
            <button
              key={item.id}
              onClick={() => openOne(item)}
              className="w-full text-start px-3 py-2.5 border-b border-[var(--line)] tap"
              style={{ background: item.unread ? "var(--surf-2)" : "transparent" }}>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: item.unread ? TONE_COLOR[notificationTone(item.kind)] : "transparent" }} />
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold leading-5">{item.title}</div>
                  {item.body && <div className="text-[11px] leading-5 text-[var(--txt-2)] mt-0.5">{item.body}</div>}
                  <div className="text-[10px] text-[var(--txt-3)] mt-1">{when(item.createdAt)}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
