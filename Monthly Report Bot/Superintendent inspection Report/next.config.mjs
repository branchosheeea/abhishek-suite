/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async redirects() {
    // The editor moved under /inspections; keep old links and bookmarks (?id=…) working.
    // Temporary (307) so browsers do not cache it permanently.
    return [{ source: "/report", destination: "/inspections/report", permanent: false }]
  },
}

export default nextConfig
