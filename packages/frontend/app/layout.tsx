import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/toaster'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin'] })

// In Spanish, like the app: every page without its own title (the widget,
// the legal pages, errors) showed the English one.
export const metadata: Metadata = {
  title: 'KiraRoom · Gestión de salones de belleza',
  description: 'Programa para salones de belleza: agenda y reservas online, clientas, caja y facturación.',
  keywords: 'salón de belleza, reservas online, agenda, programa para peluquerías, gestión de salones',
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