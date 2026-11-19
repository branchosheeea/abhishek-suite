import type { Metadata, Viewport } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: { default: "Emissions Validation", template: "%s · Emissions Validation · NeraVeda" },
  description: "NeraVeda Workspace 07: read-only validation and investigation of DNV emissions reporting data.",
  applicationName: "NeraVeda",
}

export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0E2A47" },
    { media: "(prefers-color-scheme: dark)", color: "#0B1F35" },
  ],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
