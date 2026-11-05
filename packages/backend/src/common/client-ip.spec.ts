import express from "express";
import request from "supertest";
import { TRUSTED_PROXIES } from "./http-hardening";
import { clientIp } from "./client-ip";

/**
 * R17: the IP recorded with a booking's consent choices was the first value
 * of X-Forwarded-For, which the client sends. Behind Traefik the real
 * address is the one the trusted proxy appends.
 */
describe("clientIp", () => {
  const app = express();
  app.set("trust proxy", TRUSTED_PROXIES);
  app.get("/ip", (req, res) => res.json({ ip: clientIp(req) }));

  it("ignores an address the client wrote in X-Forwarded-For", async () => {
    // supertest connects from loopback (a trusted hop): the right-most
    // untrusted value is the client's, a forged left-most one is not used.
    const res = await request(app).get("/ip").set("X-Forwarded-For", "203.0.113.9, 198.51.100.7");
    expect(res.body.ip).toBe("198.51.100.7");
  });

  it("is the socket's address when no proxy says otherwise", async () => {
    const res = await request(app).get("/ip");
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it("is empty without a request", () => {
    expect(clientIp(undefined)).toBe("");
  });
});
