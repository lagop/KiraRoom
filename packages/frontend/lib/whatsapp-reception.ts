/**
 * The WhatsApp settings page's checks (channels audit, phase 2).
 *
 * "Probar recepción": the backend gives the time from which an event from
 * Meta counts (`since`); the page polls the connection until its
 * lastInboundAt passes it, or gives up after RECEPTION_TEST_MS.
 */

export const RECEPTION_TEST_MS = 3 * 60 * 1000;
export const RECEPTION_POLL_MS = 5 * 1000;

export type ReceptionTestState =
  | { kind: "idle" }
  | { kind: "unavailable"; reason: string }
  | { kind: "waiting"; since: string; startedAt: number }
  | { kind: "received"; at: string }
  | { kind: "timeout" };

/** What the page shows after a poll of the connection. */
export function receptionPoll(
  state: ReceptionTestState,
  lastInboundAt: string | null | undefined,
  now: number,
): ReceptionTestState {
  if (state.kind !== "waiting") return state;
  if (lastInboundAt && new Date(lastInboundAt).getTime() >= new Date(state.since).getTime()) {
    return { kind: "received", at: lastInboundAt };
  }
  return now - state.startedAt >= RECEPTION_TEST_MS ? { kind: "timeout" } : state;
}

/** The reasons Meta gave for templates it did not take, from POST /whatsapp/templates/standard. */
export function templateSubmitErrors(result: Record<string, string> | null | undefined): string[] {
  const errors = Object.values(result ?? {})
    .filter((v) => typeof v === "string" && v.startsWith("ERROR: "))
    .map((v) => v.slice("ERROR: ".length).trim())
    .filter(Boolean);
  return Array.from(new Set(errors));
}
