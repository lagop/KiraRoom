/**
 * Which email settings apply (console, else the server's .env), and the
 * checks on what the admin types in the console.
 */
import {
  apiKeyProblem,
  lastFour,
  parseSender,
  redactSecrets,
  resolveEmailSettings,
  senderDomain,
  senderProblem,
  webhookSecretProblem,
} from "./email-settings";

// Built at runtime: fictitious values that only look like Resend's.
const consoleKey = ["re", "consoleKey12345678"].join("_");
const serverKey = ["re", "serverKey123456789"].join("_");

describe("resolveEmailSettings", () => {
  it("prefers what is set in the console", () => {
    const s = resolveEmailSettings(
      { apiKey: consoleKey, from: "KiraRoom <notificaciones@kiraroom.com>" },
      { apiKey: serverKey, from: "noreply@kiraroom.com", webhookSecret: "whsec_server" },
    );
    expect(s.apiKey).toBe(consoleKey);
    expect(s.from).toBe("KiraRoom <notificaciones@kiraroom.com>");
    expect(s.sources).toEqual({ apiKey: "console", from: "console", webhookSecret: "server" });
    expect(s.webhookSecret).toBe("whsec_server");
  });

  it("falls back to the server's .env, and says when there is nothing", () => {
    const s = resolveEmailSettings({}, { apiKey: serverKey });
    expect(s.apiKey).toBe(serverKey);
    expect(s.sources).toEqual({ apiKey: "server", from: "none", webhookSecret: "none" });
  });

  it("treats empty or blank values as unset", () => {
    const s = resolveEmailSettings({ apiKey: "  ", from: null }, { apiKey: "", from: "noreply@kiraroom.com" });
    expect(s.apiKey).toBeNull();
    expect(s.sources.apiKey).toBe("none");
    expect(s.sources.from).toBe("server");
  });
});

describe("sender", () => {
  it("reads a bare address and one with a name", () => {
    expect(parseSender("notificaciones@kiraroom.com")).toEqual({ address: "notificaciones@kiraroom.com", name: null });
    expect(parseSender("KiraRoom <notificaciones@kiraroom.com>")).toEqual({
      address: "notificaciones@kiraroom.com",
      name: "KiraRoom",
    });
    expect(parseSender('"Kira Room" <a@b.es>')).toEqual({ address: "a@b.es", name: "Kira Room" });
  });

  it("gives the domain of the address, not of the whole line", () => {
    expect(senderDomain("KiraRoom <notificaciones@KiraRoom.com>")).toBe("kiraroom.com");
    expect(senderDomain("noreply@mi-dominio.es")).toBe("mi-dominio.es");
  });

  it("refuses what is not an address", () => {
    expect(senderProblem("notificaciones")).not.toBeNull();
    expect(senderProblem("KiraRoom <>")).not.toBeNull();
    expect(senderProblem("a@b.es c@d.es")).not.toBeNull();
    expect(senderProblem("KiraRoom <notificaciones@kiraroom.com>")).toBeNull();
  });
});

describe("what the admin pastes", () => {
  it("expects a Resend key", () => {
    expect(apiKeyProblem(consoleKey)).toBeNull();
    expect(apiKeyProblem("sk-ant-something")).toMatch(/re_/);
    expect(apiKeyProblem("re_")).not.toBeNull();
  });

  it("expects a webhook signing secret", () => {
    expect(webhookSecretProblem("whsec_" + Buffer.from("fictitious-key").toString("base64"))).toBeNull();
    expect(webhookSecretProblem(consoleKey)).toMatch(/whsec_/);
  });

  it("shows only the last four characters", () => {
    expect(lastFour(consoleKey)).toBe("5678");
    expect(lastFour("short")).toBeNull();
    expect(lastFour(null)).toBeNull();
  });

  it("takes keys and secrets out of provider errors", () => {
    expect(redactSecrets(`API key ${consoleKey} is invalid`)).toBe("API key re_*** is invalid");
    expect(redactSecrets("bad whsec_abcdefghij")).toBe("bad whsec_***");
  });
});
