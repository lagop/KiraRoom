import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchPublicReviews, fetchPublicSalonPage } from "@/lib/public-site-server";
import {
  acceptsBookings,
  canonicalUrl,
  metaDescription,
  metaTitle,
  publicImageSrc,
  salonJsonLd,
  serializeJsonLd,
  shareImage,
} from "@/lib/salon-seo";
import SalonBookingPage from "./salon-booking-page";

/**
 * A salon's public page, rendered on the server.
 *
 * It used to be one client component that fetched everything after load.
 * Search engines got a spinner, the root layout's generic title, and a 200
 * even for salons that do not exist. Now the server fetches the salon once
 * (GET /public-site/page/:slug), writes the title, description, canonical
 * URL, Open Graph tags and schema.org data, and hands the same data to the
 * booking UI, which stays a client component and is still rendered into the
 * HTML: the name, services with prices, team, hours and reviews are in the
 * page source.
 */
// A literal: Next reads segment config statically. Same value as
// SALON_PAGE_REVALIDATE_SECONDS, which the fetch itself uses.
export const revalidate = 300;

type Props = { params: { salonName: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await fetchPublicSalonPage(params.salonName);
  if (!page) return { title: "Salón no encontrado", robots: { index: false } };

  const url = canonicalUrl(page);
  const title = metaTitle(page);
  const description = metaDescription(page);
  const image = shareImage(page);
  const logo = publicImageSrc(page.logoUrl);

  return {
    title,
    description,
    alternates: { canonical: url },
    // A salon that takes no bookings (trial ended, cancelled, suspended)
    // keeps its page, with its phone, but out of search results.
    ...(acceptsBookings(page) ? {} : { robots: { index: false, follow: true } }),
    // The salon's logo in the tab and bookmarks; else the app's icon.
    ...(logo ? { icons: { icon: logo } } : {}),
    openGraph: {
      type: "website",
      url,
      title,
      description,
      siteName: page.name,
      locale: "es_ES",
      ...(image ? { images: [{ url: image, alt: page.name }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function SalonPage({ params }: Props) {
  const page = await fetchPublicSalonPage(params.salonName);
  if (!page) notFound();

  const jsonLd = serializeJsonLd(salonJsonLd(page, canonicalUrl(page)));
  const reviews = await fetchPublicReviews(page.id);

  return (
    <>
      <script
        type="application/ld+json"
        // Escaped by serializeJsonLd: salon text cannot close the tag.
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <SalonBookingPage salonName={params.salonName} initialData={page} initialReviews={reviews} />
    </>
  );
}
