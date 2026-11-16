import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { ThemeProvider } from 'next-themes'
import { Toaster } from '@/components/ui/sonner'
import { ServiceWorkerRegister } from '@/components/sw-register'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'NeraVeda', template: '%s · NeraVeda' },
  description:
    'NeraVeda web workspaces, including the offline-first Superintendent’s Detailed Inspection Report (16.02.00.003.04) with cloud sync and PDF export.',
  applicationName: 'NeraVeda',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'NeraVeda', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/icon-light-32x32.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark-32x32.png', media: '(prefers-color-scheme: dark)' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0E2A47' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1F35' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster position="bottom-center" />
        </ThemeProvider>
        <ServiceWorkerRegister />
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
