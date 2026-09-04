"use client";

import { useEffect, useState } from "react";
import { Star, Filter } from "lucide-react";
import apiClient, { Review, ReviewAnalytics } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

export default function ReviewsDashboardPage() {
  const { toast } = useToast();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [analytics, setAnalytics] = useState<ReviewAnalytics | null>(null);
  const [rating, setRating] = useState<number | "all">("all");
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [list, stats] = await Promise.all([
        apiClient.listReviews({
          rating: rating === "all" ? undefined : Number(rating),
          status: status || undefined,
        }),
        apiClient.getReviewAnalytics(),
      ]);
      setReviews(list);
      setAnalytics(stats);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rating, status]);

  async function moderate(id: string, action: "approve" | "reject") {
    try {
      await apiClient.moderateReview(id, action);
      toast({ title: action === "approve" ? "Aprobada" : "Rechazada" });
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">Reseñas</h1>
        <p className="text-gray-500 mt-1">
          Reseñas internas + flujo de deep-link a Google Business Profile.
        </p>
      </div>

      {analytics && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card label="Rating medio" value={analytics.averageRating.toFixed(2)} />
          <Card label="Total" value={String(analytics.total)} />
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="text-xs text-gray-500 uppercase mb-2">
              Distribución
            </div>
            <div className="space-y-1">
              {analytics.distribution
                .slice()
                .reverse()
                .map((count, idx) => {
                  const stars = 5 - idx;
                  const pct = analytics.total
                    ? Math.round((count / analytics.total) * 100)
                    : 0;
                  return (
                    <div key={stars} className="flex items-center gap-2 text-xs">
                      <span className="w-6">{stars}★</span>
                      <div className="flex-1 bg-gray-100 rounded h-2 overflow-hidden">
                        <div
                          className="bg-yellow-400 h-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-10 text-right">{count}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex flex-col gap-2 mb-4 sm:flex-row sm:items-center sm:gap-3">
          <Filter className="hidden w-4 h-4 text-gray-500 sm:block" />
          <select
            value={rating}
            onChange={(e) =>
              setRating(e.target.value === "all" ? "all" : Number(e.target.value))
            }
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm sm:w-auto"
          >
            <option value="all">Todas las estrellas</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n}★ y más
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm sm:w-auto"
          >
            <option value="">Todos los estados</option>
            <option value="published">Publicado</option>
            <option value="moderation">Moderación</option>
            <option value="rejected">Rechazado</option>
          </select>
        </div>
        {loading ? (
          <div className="text-gray-500 text-sm">Cargando…</div>
        ) : reviews.length === 0 ? (
          <div className="text-gray-500 text-sm">Sin reseñas todavía.</div>
        ) : (
          <div className="divide-y">
            {reviews.map((r) => (
              <div key={r.id} className="py-3 flex items-start gap-3">
                <div className="flex">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Star
                      key={n}
                      className={`w-4 h-4 ${
                        n <= r.rating
                          ? "fill-yellow-400 text-yellow-400"
                          : "text-gray-200"
                      }`}
                    />
                  ))}
                </div>
                <div className="flex-1">
                  <div className="text-xs text-gray-500">
                    {new Date(r.createdAt).toLocaleString()} · {r.source}
                    {r.publishedToGoogle && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                        Google
                      </span>
                    )}
                  </div>
                  {r.comment && (
                    <div className="text-sm text-gray-700 mt-1">{r.comment}</div>
                  )}
                </div>
                {r.status === "moderation" && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => moderate(r.id, "approve")}
                      className="text-xs text-green-700 hover:bg-green-50 px-2 py-1 rounded"
                    >
                      Aprobar
                    </button>
                    <button
                      onClick={() => moderate(r.id, "reject")}
                      className="text-xs text-red-700 hover:bg-red-50 px-2 py-1 rounded"
                    >
                      Rechazar
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 mt-1">{value}</div>
    </div>
  );
}