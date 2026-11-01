import { DEFAULT_CAMPAIGN_RATE_PER_MINUTE, EmailPacer, campaignRatePerMinute } from "./email-pacer";
import { cleanDisplayName, senderWithName } from "../platform/email-settings";

/**
 * Campaign emails go out at a set pace, all salons together: they share one
 * sending domain, and a burst of thousands is what gets it throttled.
 */
describe("EmailPacer", () => {
  function pacer(rate?: string) {
    const p = new EmailPacer({ get: () => rate } as any);
    let clock = 1_000_000;
    const slept: number[] = [];
    (p as any).now = () => clock;
    (p as any).sleep = async (ms: number) => {
      slept.push(ms);
      clock += ms;
    };
    return { p, slept, advance: (ms: number) => (clock += ms) };
  }

  it("reads the rate from EMAIL_CAMPAIGN_RATE_PER_MINUTE, 120 by default", () => {
    expect(campaignRatePerMinute(undefined)).toBe(DEFAULT_CAMPAIGN_RATE_PER_MINUTE);
    expect(campaignRatePerMinute("")).toBe(120);
    expect(campaignRatePerMinute("abc")).toBe(120);
    expect(campaignRatePerMinute("-5")).toBe(120);
    expect(campaignRatePerMinute("60")).toBe(60);
    expect(campaignRatePerMinute("999999")).toBe(6000);
  });

  it("spaces the emails evenly over the minute", async () => {
    const { p, slept } = pacer("60");
    await p.wait();
    await p.wait();
    await p.wait();
    expect(slept).toEqual([1000, 1000]);
  });

  it("does not wait after a pause longer than the interval", async () => {
    const { p, slept, advance } = pacer("120");
    await p.wait();
    advance(5000);
    await p.wait();
    expect(slept).toEqual([]);
  });

  it("shares the pace between callers waiting at the same time", async () => {
    const { p } = pacer("60");
    const order: number[] = [];
    // No clock advance between them: each takes the next free slot.
    const slots: number[] = [];
    (p as any).sleep = async (ms: number) => {
      slots.push(ms);
    };
    await Promise.all([p.wait().then(() => order.push(1)), p.wait().then(() => order.push(2)), p.wait().then(() => order.push(3))]);
    expect(slots).toEqual([1000, 2000]);
  });
});

describe("the sender's display name", () => {
  it("is the salon's name in front of the platform's address", () => {
    expect(senderWithName("Salón Lucía", "KiraRoom <notificaciones@kiraroom.com>")).toBe('"Salón Lucía" <notificaciones@kiraroom.com>');
    expect(senderWithName("Salón Lucía", "notificaciones@kiraroom.com")).toBe('"Salón Lucía" <notificaciones@kiraroom.com>');
  });

  it("cannot break out of the header: no quotes, angle brackets, backslashes or line breaks", () => {
    expect(cleanDisplayName('Ana "la mejor" <x>\\ \r\nBcc: otra@example.test')).toBe("Ana la mejor x Bcc: otra@example.test");
    expect(cleanDisplayName("a".repeat(100))).toHaveLength(70);
  });

  it("keeps the platform sender when there is no usable name or no address", () => {
    expect(senderWithName('  "" ', "KiraRoom <n@kiraroom.com>")).toBe("KiraRoom <n@kiraroom.com>");
    expect(senderWithName(null, "KiraRoom <n@kiraroom.com>")).toBe("KiraRoom <n@kiraroom.com>");
    expect(senderWithName("Salón", "not an address")).toBe("not an address");
  });
});
