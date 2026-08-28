import React from "react";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { BrandLogo } from "../../brand/BrandLogo.jsx";
import { reportFault } from "../../services/faultReport.js";

export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error("ZEMAN render recovery", error, info);
    // And somewhere a person can actually read it. The console of a customer's phone is not a
    // place anybody looks; this is the difference between knowing a screen broke and finding
    // out weeks later from a phone call with nothing in it.
    reportFault("render", error, this.props.screen, info?.componentStack || error?.stack || "");
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="min-h-screen grid place-items-center bg-[#081311] px-5 py-10" dir="rtl">
      <section className="w-full max-w-lg rounded-[28px] border border-white/10 bg-white/[.055] p-6 text-white shadow-2xl md:p-8" role="alert" aria-labelledby="zeman-recovery-title">
        <BrandLogo variant="horizontal-dark" className="h-12 w-auto" />
        <span className="mt-8 grid h-12 w-12 place-items-center rounded-2xl bg-rose-400/10 text-rose-300"><ShieldAlert aria-hidden="true" /></span>
        <h1 id="zeman-recovery-title" className="mt-4 text-2xl font-extrabold">پەڕەکە پێویستی بە نوێکردنەوە هەیە</h1>
        <p className="mt-2 text-sm leading-7 text-white/65">داتای دارایی نەگۆڕدراوە. پەڕەکە نوێ بکەرەوە بۆ گەڕانەوە بۆ ZEMAN.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-xl bg-emerald-400 px-5 py-3 text-sm font-bold text-emerald-950">
          <RefreshCw aria-hidden="true" className="h-4 w-4" /> نوێکردنەوەی پارێزراو
        </button>
      </section>
    </main>;
  }
}
