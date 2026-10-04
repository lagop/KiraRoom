"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

interface PublicReviews {
  averageRating: number;
  total: number;
  reviews: Array<{ id: string; rating: number; comment: string | null; author: string; date: string }>;
}

/**
 * Reviews the salon approved in its panel, collected from its own clients
 * after their visits. Renders nothing until there is at least one: an empty
 * "0 reviews" block would only hurt the salon.
 */
export default function PublicReviewsSection({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<PublicReviews | null>(null);

  useEffect(() => {
    fetch(`${API}/public/reviews/tenant/${encodeURIComponent(tenantId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, [tenantId]);

  if (!data || data.total === 0) return null;

  return (
    <div className="mt-8 bg-white rounded-2xl shadow-lg p-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-bold text-purple-900">Opiniones de clientas</h3>
        <div className="flex items-center gap-1 text-sm text-gray-700">
          <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
          <span className="font-semibold">{data.averageRating.toFixed(1)}</span>
          <span className="text-gray-500">({data.total})</span>
        </div>
      </div>
      <div className="space-y-4">
        {data.reviews.map((r) => (
          <div key={r.id} className="border-b border-gray-100 pb-3 last:border-0">
            <div className="flex items-center gap-2">
              <div className="flex">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star
                    key={n}
                    className={`w-3.5 h-3.5 ${n <= r.rating ? "fill-yellow-400 text-yellow-400" : "text-gray-200"}`}
                  />
                ))}
              </div>
              <span className="text-sm font-medium text-gray-900">{r.author}</span>
              <span className="text-xs text-gray-500">
                {new Date(r.date).toLocaleDateString("es-ES", { month: "long", year: "numeric" })}
              </span>
            </div>
            {r.comment && <p className="text-sm text-gray-700 mt-1">{r.comment}</p>}
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-3">
        Solo pueden opinar clientas con una cita completada en el salón. El
        salón revisa las opiniones antes de publicarlas.
      </p>
    </div>
  );
}
