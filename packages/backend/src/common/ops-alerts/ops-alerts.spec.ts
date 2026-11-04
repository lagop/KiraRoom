import "reflect-metadata";
import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { OpsAlertService, opsAlertRecipient } from "./ops-alert.service";
import { MonitoredJob, reportJobFailure, setOpsAlertSink } from "./ops-alert-sink";
import { SentryExceptionFilter, statusOf } from "../observability/sentry-exception.filter";
import { scrubEvent } from "../../instrument";

/**
 * Audit 8 D6 / D15: server errors never reached GlitchTip, and an AEAT
 * rejection, a failed scheduled job or a spike of bounces only reached the
 * logs. Now they email the platform owner, at most one per kind per hour.
 */

function memoryRedis() {
  const store = new Map<string, string>();
  return {
    store,
    setIfAbsent: jest.fn(async (k: string, v: string) => {
      if (store.has(k)) return false;
      store.set(k, v);
      return true;
    }),
    increment: jest.fn(async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => void store.delete(k)),
  };
}

describe("OpsAlertService", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("emails admin@kiraroom.net by default, or OPS_ALERT_EMAIL / FOUNDER_EMAIL", () => {
    expect(opsAlertRecipient({})).toBe("admin@kiraroom.net");
    expect(opsAlertRecipient({ FOUNDER_EMAIL: "f@example.com" })).toBe("f@example.com");
    expect(opsAlertRecipient({ FOUNDER_EMAIL: "f@example.com", OPS_ALERT_EMAIL: "ops@example.com" })).toBe("ops@example.com");
    expect(opsAlertRecipient({ OPS_ALERT_EMAIL: "  " })).toBe("admin@kiraroom.net");
  });

  it("sends at most one email per kind per hour and mentions the ones held back", async () => {
    const email = { sendEmail: jest.fn().mockResolvedValue({ success: true }) };
    const redis = memoryRedis();
    const svc = new OpsAlertService(email as any, redis as any);

    expect(await svc.notify("job_failed", "a", "x")).toBe(true);
    expect(await svc.notify("job_failed", "b", "y")).toBe(false);
    expect(await svc.notify("job_failed", "c", "z")).toBe(false);
    // Another kind is not held back by this one.
    expect(await svc.notify("fiscal_rejected", "F1", "AEAT 400")).toBe(true);
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    expect(email.sendEmail.mock.calls[0][0].to).toBe("admin@kiraroom.net");

    // An hour later (the key expired) the next one goes out, counting the two held.
    redis.store.delete("ops-alert:job_failed");
    await svc.notify("job_failed", "d", "w");
    expect(email.sendEmail).toHaveBeenCalledTimes(3);
    expect(email.sendEmail.mock.calls[2][0].text).toContain("+2");
  });

  it("escapes what it puts in the email and never throws", async () => {
    const email = { sendEmail: jest.fn().mockResolvedValue({ success: true }) };
    const svc = new OpsAlertService(email as any, memoryRedis() as any);
    await svc.notify("fiscal_rejected", "<b>x</b>", "<img>");
    expect(email.sendEmail.mock.calls[0][0].html).not.toContain("<img>");

    const broken = new OpsAlertService({ sendEmail: jest.fn().mockRejectedValue(new Error("down")) } as any, memoryRedis() as any);
    await expect(broken.notify("job_failed", "t", "d")).resolves.toBe(false);
  });

  it("alerts once the day's complaints reach the threshold, counting each event once", async () => {
    process.env.OPS_ALERT_COMPLAINTS_PER_DAY = "2";
    const email = { sendEmail: jest.fn().mockResolvedValue({ success: true }) };
    const svc = new OpsAlertService(email as any, memoryRedis() as any);
    const now = new Date("2026-11-04T10:00:00Z");
    await svc.recordEmailEvent("complaint", "evt-1", now);
    await svc.recordEmailEvent("complaint", "evt-1", now); // Svix redelivery
    expect(email.sendEmail).not.toHaveBeenCalled();
    await svc.recordEmailEvent("complaint", "evt-2", now);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0].subject).toContain("Quejas de spam");
  });
});

describe("@MonitoredJob", () => {
  afterEach(() => setOpsAlertSink(null));

  class Jobs {
    calls = 0;
    @MonitoredJob("Jobs.nightly")
    async nightly(): Promise<void> {
      this.calls++;
      throw new Error("boom");
    }
    @MonitoredJob("Jobs.ok")
    async ok(): Promise<number> {
      return 7;
    }
  }

  it("reports a job that throws instead of letting it vanish in a log line", async () => {
    const sink = jest.fn().mockResolvedValue(undefined);
    setOpsAlertSink(sink);
    const capture = jest.spyOn(Sentry, "captureException").mockReturnValue("id");
    const jobs = new Jobs();
    await expect(jobs.nightly()).resolves.toBeUndefined();
    expect(jobs.calls).toBe(1);
    expect(sink).toHaveBeenCalledWith("job_failed", "Jobs.nightly", expect.stringContaining("boom"));
    expect(capture).toHaveBeenCalledWith(expect.any(Error), { tags: { job: "Jobs.nightly" } });
    expect(await jobs.ok()).toBe(7);
    capture.mockRestore();
  });

  it("keeps the metadata @Cron put on the method", () => {
    const proto: any = {};
    const original = function cron() {};
    Reflect.defineMetadata("SCHEDULE_CRON_OPTIONS", { cronTime: "0 * * * *" }, original);
    const descriptor = { value: original, writable: true, configurable: true };
    MonitoredJob("x")(proto, "cron", descriptor);
    expect(Reflect.getMetadata("SCHEDULE_CRON_OPTIONS", descriptor.value)).toEqual({ cronTime: "0 * * * *" });
  });

  it("does nothing more than log without a sink", async () => {
    await expect(reportJobFailure("x", "not an error")).resolves.toBeUndefined();
  });
});

describe("SentryExceptionFilter", () => {
  it("reports 5xx and unexpected errors with the route pattern, not 4xx", () => {
    const capture = jest.spyOn(Sentry, "captureException").mockReturnValue("id");
    const filter = new SentryExceptionFilter();
    // Do not run Nest's response writing here.
    const base = jest
      .spyOn(Object.getPrototypeOf(SentryExceptionFilter.prototype), "catch")
      .mockImplementation(() => undefined);
    const host: any = {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => ({ method: "GET", route: { path: "/clients/:id" }, body: { taxId: "x" } }) }),
    };

    filter.catch(new BadRequestException("no"), host);
    expect(capture).not.toHaveBeenCalled();

    filter.catch(new Error("db down"), host);
    filter.catch(new InternalServerErrorException(), host);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0][1]).toEqual({
      tags: { "http.method": "GET", "http.route": "/clients/:id", "http.status_code": "500" },
    });
    expect(statusOf(new BadRequestException())).toBe(400);
    expect(base).toHaveBeenCalledTimes(3);
    base.mockRestore();
    capture.mockRestore();
  });

  it("scrubs bodies, query strings, credentials and user details from events", () => {
    const event = scrubEvent({
      request: {
        url: "https://api.example.com/clients?taxId=B1",
        data: { name: "x" },
        cookies: { a: "b" },
        query_string: "taxId=B1",
        headers: { authorization: "Bearer t", "user-agent": "ua", cookie: "c" },
      },
      user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
    } as any);
    expect(event.request).toEqual({ url: "https://api.example.com/clients", headers: { "user-agent": "ua" } });
    expect(event.user).toEqual({ id: "u1" });
  });
});
