import type { Metadata } from "next";

/**
 * The widget's page inside the salon's iframe. It inherited the root
 * layout's "KiraRoom - Beauty Salon Management"; the page sets
 * "Reservar en <salón>" once it knows the salon. Never indexed: it is the
 * salon's page that should be found, not its widget.
 */
export const metadata: Metadata = {
  title: "Reservar cita",
  robots: { index: false, follow: false },
};

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
