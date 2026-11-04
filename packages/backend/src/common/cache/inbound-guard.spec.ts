import { RedisService } from "./redis.service";
import { InboundGuard } from "./inbound-guard";

/**
 * Channels audit M12: dedupe and the per-sender cap live in Redis (SET NX
 * EX / INCR + EXPIRE), with the in-memory map when Redis is not configured
 * or fails at that moment.
 */
const noConfig = { get: () => undefined } as any;

function withClient(client: any) {
  const redis = new RedisService(noConfig);
  (redis as any).client = client;
  return redis;
}

describe("RedisService: setIfAbsent and increment", () => {
  it("uses SET NX EX and INCR + EXPIRE (only on the first increment) when Redis is there", async () => {
    const client = {
      set: jest.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null),
      incr: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
      expire: jest.fn(async () => true),
    };
    const redis = withClient(client);
    expect(await redis.setIfAbsent("k", "1", 60)).toBe(true);
    expect(await redis.setIfAbsent("k", "1", 60)).toBe(false);
    expect(client.set).toHaveBeenCalledWith("k", "1", { NX: true, EX: 60 });
    expect(await redis.increment("c", 3600)).toBe(1);
    expect(await redis.increment("c", 3600)).toBe(2);
    expect(client.expire).toHaveBeenCalledTimes(1);
    expect(client.expire).toHaveBeenCalledWith("c", 3600);
  });

  it("falls back to memory when Redis fails at that moment, still once per key", async () => {
    const down = () => Promise.reject(new Error("ECONNRESET"));
    const redis = withClient({ set: jest.fn(down), incr: jest.fn(down), expire: jest.fn(down) });
    (redis as any).logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    expect(await redis.setIfAbsent("k", "1", 60)).toBe(true);
    expect(await redis.setIfAbsent("k", "1", 60)).toBe(false);
    expect(await redis.increment("c", 60)).toBe(1);
    expect(await redis.increment("c", 60)).toBe(2);
  });

  it("an expired key can be claimed again", async () => {
    const redis = new RedisService(noConfig);
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(await redis.setIfAbsent("k", "1", 10)).toBe(true);
    now.mockReturnValue(1_000_000 + 11_000);
    expect(await redis.setIfAbsent("k", "1", 10)).toBe(true);
    now.mockRestore();
  });
});

describe("InboundGuard", () => {
  it("handles a delivery once and counts a sender per clock hour", async () => {
    const guard = new InboundGuard(new RedisService(noConfig), "test");
    expect(await guard.firstDelivery("wamid.1")).toBe(true);
    expect(await guard.firstDelivery("wamid.1")).toBe(false);
    const t = Date.UTC(2026, 10, 4, 10, 5);
    expect(await guard.withinHourlyCap("+34600000000", 2, t)).toBe(true);
    expect(await guard.withinHourlyCap("+34600000000", 2, t)).toBe(true);
    expect(await guard.withinHourlyCap("+34600000000", 2, t)).toBe(false);
    // The next hour starts over.
    expect(await guard.withinHourlyCap("+34600000000", 2, t + 60 * 60 * 1000)).toBe(true);
  });

  it("keeps no phone number in the keys", async () => {
    const client = { set: jest.fn(async () => "OK"), incr: jest.fn(async () => 1), expire: jest.fn(async () => true) };
    const guard = new InboundGuard(withClient(client), "vr:wa");
    await guard.firstDelivery("wamid.1");
    await guard.withinHourlyCap("+34600000000", 5);
    const keys = [...client.set.mock.calls, ...client.incr.mock.calls].map((c: any[]) => c[0] as string);
    for (const k of keys) {
      expect(k.startsWith("vr:wa:")).toBe(true);
      expect(k).not.toContain("600000000");
    }
  });
});
