import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { Throttle, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { ThrottlerBehindProxyGuard } from "./guards/throttler-behind-proxy.guard";
import { applyHttpHardening, swaggerEnabled } from "./http-hardening";

/**
 * The throttler guard was an empty class, so no limit ever applied; helmet
 * was installed but never used. These run a real Nest app over HTTP.
 */
@Controller("t")
class LimitedController {
  @Get("login")
  @Throttle({ default: { ttl: 60_000, limit: 2 } })
  login() {
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])],
  controllers: [LimitedController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard }],
})
class TestAppModule {}

describe("HTTP hardening", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(TestAppModule, { logger: false });
    applyHttpHardening(app);
    await app.init();
  });

  afterAll(() => app.close());

  it("limits a route per client address", async () => {
    const from = (ip: string) => request(app.getHttpServer()).get("/t/login").set("X-Forwarded-For", ip);
    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.1")).status).toBe(429);
    // Another visitor behind the same proxy has their own allowance.
    expect((await from("203.0.113.2")).status).toBe(200);
  });

  it("sends security headers and hides the framework", async () => {
    const res = await request(app.getHttpServer()).get("/t/login").set("X-Forwarded-For", "203.0.113.9");
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("serves the API docs only outside production, unless asked", () => {
    expect(swaggerEnabled({ NODE_ENV: "development" } as any)).toBe(true);
    expect(swaggerEnabled({ NODE_ENV: "production" } as any)).toBe(false);
    expect(swaggerEnabled({ NODE_ENV: "production", SWAGGER_ENABLED: "1" } as any)).toBe(true);
  });
});
