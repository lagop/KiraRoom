import type { ReactNode } from "react";
import { salonLegalNoticePath, salonPrivacyPath } from "@/lib/salon-legal";

/**
 * The frame of a salon's privacy page and aviso legal: plain, readable on a
 * phone, with the way back to the salon's page and to the other text.
 */
export function SalonLegalLayout({
  slug,
  salonName,
  title,
  children,
}: {
  slug: string;
  salonName: string;
  title: string;
  children: ReactNode;
}) {
  const home = `/sites/${encodeURIComponent(slug)}`;
  return (
    <div className="min-h-screen bg-gray-50">
      <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <a href={home} className="text-sm text-purple-700 hover:underline">
          ← {salonName}
        </a>
        <h1 className="mt-4 text-3xl font-bold text-gray-900">{title}</h1>
        <div className="mt-6 space-y-6 break-words rounded-2xl bg-white p-4 text-gray-700 shadow-sm sm:p-8 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-gray-900 [&_li]:ml-5 [&_li]:list-disc [&_p]:leading-relaxed">
          {children}
        </div>
      </main>
      <footer className="border-t border-gray-200 bg-white py-6 text-center text-sm text-gray-500">
        <a href={salonLegalNoticePath(slug)} className="hover:text-purple-700 hover:underline">
          Aviso legal
        </a>
        {" · "}
        <a href={salonPrivacyPath(slug)} className="hover:text-purple-700 hover:underline">
          Privacidad
        </a>
        <p className="mt-2">Web de reservas gestionada por KiraRoom</p>
      </footer>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
