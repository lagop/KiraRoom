import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/toaster'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'KiraStudio - Beauty Salon Management',
  description: 'Professional beauty salon management platform with appointment booking, client management, and more.',
  keywords: 'beauty salon, appointment booking, salon management, beauty business',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="es">
      <body className={inter.className}>
        <Providers>
          <div className="min-h-screen bg-background">
            {children}
            <Toaster />
          </div>
        </Providers>
      </body>
    </html>
  )
}