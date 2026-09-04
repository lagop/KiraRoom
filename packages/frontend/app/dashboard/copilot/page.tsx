"use client";

import { CopilotPanel } from "./copilot-panel";

/**
 * P2A-staff-copilot: focused page view (full-width panel). Mirrors the
 * `CopilotPanel` component in full-page mode so users who prefer a
 * dedicated page over a slide-over still get the same experience.
 */
export default function CopilotPage() {
  return (
    <div className="h-[calc(100vh-4rem)] bg-gradient-to-br from-purple-50 via-white to-blue-50">
      <div className="max-w-3xl mx-auto h-full bg-white border border-gray-200 shadow-sm">
        <CopilotPanel fullPage />
      </div>
    </div>
  );
}
