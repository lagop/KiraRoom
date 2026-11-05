"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { publicReviewRules } from "@/lib/reviews";
import type { PublicReviews } from "@/lib/public-site-server";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

/**
 * Reviews from the salon's own clients after their visits. Renders nothing
 * until there is at least one rating: an empty "0 reviews" block would only
 * hurt the salon. Says how reviews are handled: all are published, positive
 * and negative, unless they break the listed rules.
 *
 * The page fetches them on the server (`initial`), so they are in its HTML;
 * only when that fetch failed are they asked for from the browser.
 */
export default function PublicReviewsSection({
  tenantId,
  initial,
  t,
}: {
  tenantId: string;
  initial?: PublicReviews;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const [data, setData] = useState<PublicReviews | null>(initial ?? null);

  useEffect(() => {
    if (initial) return;
    fetch(`${API}/public/reviews/tenant/${encodeURIComponent(tenantId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, [tenantId, initial]);

  if (!data || data.total === 0) return null;
  const rules = publicReviewRules(data.rejectionReasons?.length ? data.rejectionReasons : undefined);

  return (
    <div className="mt-8 bg-white rounded-2xl shadow-lg p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h3 className="text-xl font-bold text-purple-900">{t("sites.reviews.title")}</h3>
        <div className="flex items-center gap-1 text-sm text-gray-700">
          <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" aria-hidden="true" />
          <span className="font-semibold">{data.averageRating.toFixed(1)}</span>
          <span className="text-gray-500">
            ({data.total} {data.total === 1 ? t("sites.reviews.ratingOne") : t("sites.reviews.ratingOther")})
          </span>
        </div>
      </div>
      {data.reviews.length > 0 && (
        <div className="space-y-4">
          {data.reviews.map((r) => (
            <div key={r.id} className="border-b border-gray-100 pb-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex" role="img" aria-label={`${r.rating}/5`}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Star
                      key={n}
                      aria-hidden="true"
                      className={`w-3.5 h-3.5 ${n <= r.rating ? "fill-yellow-400 text-yellow-400" : "text-gray-200"}`}
                    />
                  ))}
                </div>
                <span className="text-sm font-medium text-gray-900">{r.author}</span>
                <span className="text-xs text-gray-500">
                  {new Date(r.date).toLocaleDateString("es-ES", { month: "long", year: "numeric" })}
                </span>
              </div>
              {r.comment && <p className="text-sm text-gray-700 mt-1 break-words">{r.comment}</p>}
            </div>
          ))}
        </div>
      )}
      <details className="text-xs text-gray-500 mt-3">
        <summary className="cursor-pointer">
          {t("sites.reviews.summary")} <span className="underline">{t("sites.reviews.seeRules")}</span>
        </summary>
        <p className="mt-2">{t("sites.reviews.notPublished")}</p>
        <ul className="mt-1 list-disc pl-5">
          {rules.reasons.map((reason) => (
            <li key={reason}>{reason.toLowerCase()}</li>
          ))}
        </ul>
        <p className="mt-2">{t("sites.reviews.withoutConsent")}</p>
      </details>
    </div>
  );
}
