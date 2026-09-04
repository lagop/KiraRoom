"use client";

import React, { useMemo } from "react";

interface TodayTimelineProps {
  /**
   * Today's appointments with a `scheduledTime` field formatted as
   * "HH:mm" (24-hour). Anything outside 08:00–20:00 is still
   * rendered but compressed into the last bucket.
   */
  appointments: { scheduledTime: string }[];
  startHour?: number;
  endHour?: number;
  className?: string;
}

/**
 * Hour-by-hour appointment density strip for "today's schedule at a
 * glance" on the dashboard. Each bar represents one hour and its
 * height encodes the number of appointments booked in that hour. A
 * subtle "now" marker overlays the current hour so the salon owner
 * sees where they are in the day without leaving the dashboard.
 */
export const TodayTimeline: React.FC<TodayTimelineProps> = ({
  appointments,
  startHour = 8,
  endHour = 20,
  className = "",
}) => {
  const { buckets, maxCount, currentHour, currentBucketIndex } = useMemo(() => {
    const hours = endHour - startHour;
    const buckets = Array.from({ length: hours }, (_, i) => ({
      hour: startHour + i,
      count: 0,
    }));

    appointments.forEach((apt) => {
      const match = (apt.scheduledTime || "").match(/^(\d{1,2})/);
      if (!match) return;
      const hour = parseInt(match[1], 10);
      const idx = hour - startHour;
      if (idx >= 0 && idx < hours) {
        buckets[idx].count += 1;
      } else if (hour < startHour) {
        buckets[0].count += 1;
      } else if (hour >= endHour) {
        buckets[buckets.length - 1].count += 1;
      }
    });

    const maxCount = Math.max(...buckets.map((b) => b.count), 1);
    const currentHour = new Date().getHours();
    const currentBucketIndex = Math.min(
      Math.max(currentHour - startHour, 0),
      hours - 1,
    );

    return { buckets, maxCount, currentHour, currentBucketIndex };
  }, [appointments, startHour, endHour]);

  const totalAppointments = buckets.reduce((sum, b) => sum + b.count, 0);

  return (
    <div className={className}>
      <div className="flex items-end justify-between gap-1 h-20 relative">
        {buckets.map((bucket, i) => {
          const heightPct = (bucket.count / maxCount) * 100;
          const isCurrentHour = i === currentBucketIndex;
          return (
            <div
              key={bucket.hour}
              className="flex-1 flex flex-col items-center justify-end relative h-full"
            >
              <div
                className={`w-full rounded-t transition-all duration-300 ${
                  bucket.count > 0
                    ? isCurrentHour
                      ? "bg-indigo-600"
                      : "bg-indigo-400"
                    : "bg-gray-100"
                }`}
                style={{ height: `${Math.max(heightPct, bucket.count > 0 ? 8 : 4)}%` }}
                title={`${bucket.hour}:00 – ${bucket.count} appointment${
                  bucket.count === 1 ? "" : "s"
                }`}
              />
              {isCurrentHour && (
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-red-500" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-2 text-[10px] text-gray-400 font-medium">
        {buckets.map((bucket, i) => (
          <div
            key={bucket.hour}
            className={`flex-1 text-center ${
              i === currentBucketIndex ? "text-indigo-600 font-bold" : ""
            }`}
          >
            {bucket.hour % 3 === 0 || i === buckets.length - 1
              ? `${bucket.hour.toString().padStart(2, "0")}h`
              : ""}
          </div>
        ))}
      </div>
      {totalAppointments === 0 && (
        <p className="text-xs text-gray-400 text-center mt-2">
          No appointments scheduled today
        </p>
      )}
    </div>
  );
};
