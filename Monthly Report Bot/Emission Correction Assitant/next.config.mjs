/** @type {import('next').NextConfig} */

// Security headers for every response. The CSP is applied to production builds only, because `next dev`
// needs eval and inline scripts for fast refresh.
const baseHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
]

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // The local OCR engine runs in worker threads from its own files; it must not be bundled.
  serverExternalPackages: ["tesseract.js", "tesseract.js-core", "pngjs"],
  async headers() {
    const headers = process.env.NODE_ENV === "production"
      ? [...baseHeaders, { key: "Content-Security-Policy", value: csp }]
      : baseHeaders
    return [{ source: "/:path*", headers }]
  },
}

export default nextConfig
