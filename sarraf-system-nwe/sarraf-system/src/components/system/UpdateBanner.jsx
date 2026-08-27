import { useEffect, useState } from "react";
import { RUNNING_BUILD, isStale, publishedBuild, shortBuild } from "../../services/buildVersion";

/**
 * Says out loud when the phone is running an older app than the server has.
 *
 * On the morning of 27 August the owner sent three screenshots of a message that had already been
 * removed from the source. The fix was live; the phone was not running it; and nothing on the
 * screen distinguished the two. This makes that state visible, and one tap fixes it.
 *
 * Checked on mount, whenever the app comes back to the foreground, and every ten minutes — an
 * iOS home-screen app can stay open for days without ever fetching index.html again.
 */
export function UpdateBanner({ lang = "ku" }) {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const ask = async () => {
      const published = await publishedBuild();
      if (alive && isStale(published, RUNNING_BUILD)) setStale(true);
    };
    ask();
    const onVisible = () => { if (document.visibilityState === "visible") ask(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", ask);
    const timer = setInterval(ask, 10 * 60 * 1000);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", ask);
      clearInterval(timer);
    };
  }, []);

  if (!stale) return null;

  const t = {
    ku: { title: "وەشانێکی نوێی بەرنامەکە بەردەستە", action: "نوێی بکەرەوە",
      note: "ئەم وەشانەی لەبەردەستتە کۆنە — چاککراوەکانی نوێ تێیدا نین" },
    en: { title: "A newer version of the app is available", action: "Update now",
      note: "This page is running an older build; recent fixes are not in it" },
    ar: { title: "يتوفر إصدار أحدث من التطبيق", action: "تحديث الآن",
      note: "هذه الصفحة تعمل بإصدار قديم؛ الإصلاحات الأخيرة غير موجودة فيه" },
  }[lang] || {};

  // Ask every cache to let go, then load the page again. A service worker that is only holding
  // icons still gets told, because the next build's icons may differ too.
  const update = async () => {
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      const registrations = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((registrations || []).map((r) => r.update().catch(() => {})));
    } catch { /* the reload below is what matters */ }
    window.location.reload();
  };

  return (
    <div role="status" className="px-4 pt-3">
      <div className="rounded-2xl border p-3 flex items-center gap-3 justify-between"
        style={{ background: "color-mix(in srgb, var(--warn) 10%, transparent)",
                 borderColor: "color-mix(in srgb, var(--warn) 30%, transparent)" }}>
        <div className="min-w-0">
          <div className="text-[13px] font-extrabold" style={{ color: "var(--warn)" }}>{t.title}</div>
          <div className="text-[11px]" style={{ color: "var(--txt-2)" }}>{t.note}</div>
        </div>
        <button type="button" onClick={update}
          className="shrink-0 rounded-xl px-3 py-2 text-[12px] font-extrabold text-white"
          style={{ background: "var(--warn)" }}>{t.action}</button>
      </div>
    </div>
  );
}

/**
 * Which build this screen is.
 *
 * It rides under the brand name rather than among the action buttons: it is information about
 * the application, not something to press, and eight buttons in one phone header had it sitting
 * on top of the name. `block` and `leading-none` so it costs the header no extra height.
 */
export function BuildStamp() {
  return (
    <span className="block text-[10px] leading-none tabular-nums truncate"
      style={{ color: "var(--txt-3)" }} title={RUNNING_BUILD}>{shortBuild()}</span>
  );
}
