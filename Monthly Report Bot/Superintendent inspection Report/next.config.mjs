/** @type {import('next').NextConfig} */
const nextConfig = {
  // Type errors stop the build (audit P1-8; they were ignored before). If a build fails, NeraVeda's launcher falls
  // back to `next dev` (suite_services/next_build_and_start.mjs), so the workspace still opens; fix the error and rebuild.
  images: {
    unoptimized: true,
  },
  poweredByHeader: false,
  // NEXT_DIST_DIR=.next/verify lets a build be checked while NeraVeda's server keeps serving the current .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    // Another localhost page (any other local port) must not frame or probe this app.
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    }]
  },
  async redirects() {
    // The editor moved under /inspections; keep old links and bookmarks (?id=…) working.
    // Temporary (307) so browsers do not cache it permanently.
    return [{ source: "/report", destination: "/inspections/report", permanent: false }]
  },
}

export default nextConfig
