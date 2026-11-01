import { DISCONNECTED_REASON, TOKEN_EXPIRED_REASON, accountLevelReason } from "./meta-account-errors";

/**
 * Which Meta errors stop a whole campaign (M9). Before, an expired token or
 * a payment problem was recorded against each client in turn and the whole
 * audience ended up failed.
 */
describe("accountLevelReason", () => {
  it.each(["meta_190", "meta_0", "meta_10", "meta_102", "meta_200", "meta_131005", 190])(
    "%p is an access problem: reconnect",
    (reason) => {
      expect(accountLevelReason(reason)).toBe(TOKEN_EXPIRED_REASON);
    },
  );

  it("payment, template and restriction problems each say what to do, in Spanish", () => {
    expect(accountLevelReason("meta_131042")).toMatch(/método de pago/);
    expect(accountLevelReason("meta_132015")).toMatch(/pausado la plantilla/);
    expect(accountLevelReason("meta_132016")).toMatch(/desactivado la plantilla/);
    expect(accountLevelReason("meta_132001")).toMatch(/ya no existe/);
    for (const code of ["meta_368", "meta_131031", "meta_131048", "meta_131045", "meta_133010"]) {
      expect(accountLevelReason(code)).toMatch(/restringido o bloqueado/);
    }
  });

  it("a disconnected number pauses too", () => {
    expect(accountLevelReason("not_connected")).toBe(DISCONNECTED_REASON);
  });

  it.each([
    "meta_131026", // not on WhatsApp / undeliverable
    "meta_131049", // Meta's per-user marketing limit
    "meta_131047", // outside the 24-hour window
    "meta_130429", // rate limit (handled apart: retried next minute)
    "meta_131056",
    "error",
    "",
    null,
    undefined,
    Number.NaN,
  ])("%p is about one client (or not an account problem)", (reason) => {
    expect(accountLevelReason(reason as any)).toBeNull();
  });
});
