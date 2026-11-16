"use client"

import { useEffect } from "react"

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    navigator.serviceWorker.register("/sw.js").catch(() => {})
    // Warm the PDF engine chunks so export also works after going offline.
    const warm = () => {
      import("jspdf").catch(() => {})
      import("jspdf-autotable").catch(() => {})
    }
    const handle = window.requestIdleCallback ? window.requestIdleCallback(warm) : window.setTimeout(warm, 2000)
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(handle as number)
      else window.clearTimeout(handle as number)
    }
  }, [])
  return null
}
