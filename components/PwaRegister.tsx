"use client";

import { useEffect } from "react";

/** Register the minimal service worker that makes Dejavu installable. */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* installability is best-effort */
    });
  }, []);
  return null;
}
