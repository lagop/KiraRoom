/**
 * Tests for FeatureGuard.
 *
 * Sprint 2 / Workstream 2.2 deliverable. FeatureGuard is the gatekeeper
 * that converts `subscriptionStatus in {cancelled, suspended}` into
 * the read-only mode for the customer. We test:
 *
 *   - passthrough when no @Feature() key is set on the handler
 *   - passthrough when no tenantId is on the request (public/webhook
 *     routes — other guards decide)
 *   - read-allowed when the feature is disabled but the tenant is
 *     cancelled or suspended (caller still gets 200 on GET)
 *   - write-denied when the feature is disabled and the tenant is
 *     cancelled or suspended (caller gets a 423-style payload with
 *     code SUBSCRIPTION_CANCELLED or SUBSCRIPTION_SUSPENDED)
 *   - error code distinguishes cancelled vs suspended so the frontend
 *     can render the right copy
 *
 * Like saas-owner.guard.spec.ts, no @nestjs/testing required.
 */

import { Reflector } from "@nestjs/core";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { FeatureGuard } from "./feature.guard";
import { FEATURE_KEY_METADATA } from "../decorators/feature.decorator";

function ctx(opts: {
  method?: string;
  role?: string;
  subscriptionStatus?: string;
  tenantId?: string;
  hasUser?: boolean;
}): ExecutionContext {
  const user = opts.hasUser
    ? {
        role: opts.role,
        subscriptionStatus: opts.subscriptionStatus,
        tenantId: opts.tenantId,
      }
    : undefined;
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method ?? "GET",
        user,
      }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function makeFlags(behavior: (key: string, tenantId: string) => Promise<boolean>) {
  return {
    isEnabled: jest.fn(behavior),
  } as any;
}

describe("FeatureGuard", () => {
  let guard: FeatureGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new FeatureGuard(makeFlags(async () => true), reflector);
  });

  it("passthrough when @Feature() is not set on the handler", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    await expect(guard.canActivate(ctx({ hasUser: true }))).resolves.toBe(true);
  });

  it("passthrough on public/webhook routes (no user on request)", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("widget_public");
    await expect(guard.canActivate(ctx({ hasUser: false }))).resolves.toBe(true);
  });

  describe("when the feature is enabled", () => {
    it("passes through any HTTP method", async () => {
      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("whatsapp_send");
      guard = new FeatureGuard(
        makeFlags(async () => true),
        reflector,
      );
      await expect(guard.canActivate(ctx({ method: "POST", hasUser: true }))).resolves.toBe(true);
    });
  });

  describe("when the feature is disabled and the tenant is `cancelled`", () => {
    beforeEach(() => {
      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("widget_booking");
      guard = new FeatureGuard(
        makeFlags(async () => false),
        reflector,
      );
    });

    it("allows read methods (GET/HEAD/OPTIONS) — read-only mode", async () => {
      for (const m of ["GET", "HEAD", "OPTIONS"]) {
        await expect(
          guard.canActivate(
            ctx({
              method: m,
              subscriptionStatus: "cancelled",
              tenantId: "t1",
              hasUser: true,
            }),
          ),
        ).resolves.toBe(true);
      }
    });

    it("rejects write methods with code SUBSCRIPTION_CANCELLED", async () => {
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
        await expect(
          guard.canActivate(
            ctx({
              method: m,
              subscriptionStatus: "cancelled",
              tenantId: "t1",
              hasUser: true,
            }),
          ),
        ).rejects.toMatchObject({
          response: { code: "SUBSCRIPTION_CANCELLED" },
        });
      }
    });
  });

  describe("when the feature is disabled and the tenant is `suspended`", () => {
    beforeEach(() => {
      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("widget_booking");
      guard = new FeatureGuard(
        makeFlags(async () => false),
        reflector,
      );
    });

    it("allows read methods (GET/HEAD/OPTIONS) — read-only mode", async () => {
      for (const m of ["GET", "HEAD", "OPTIONS"]) {
        await expect(
          guard.canActivate(
            ctx({
              method: m,
              subscriptionStatus: "suspended",
              tenantId: "t1",
              hasUser: true,
            }),
          ),
        ).resolves.toBe(true);
      }
    });

    it("rejects write methods with code SUBSCRIPTION_SUSPENDED (not CANCELLED)", async () => {
      // The error code distinguishes the two states so the frontend
      // can render different copy: "suspendida por falta de pago"
      // vs "cancelada".
      await expect(
        guard.canActivate(
          ctx({
            method: "POST",
            subscriptionStatus: "suspended",
            tenantId: "t1",
            hasUser: true,
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: "SUBSCRIPTION_SUSPENDED" },
      });
    });
  });

  describe("when the feature is disabled but the tenant is on a paid plan", () => {
    it("rejects with FEATURE_NOT_IN_PLAN (regardless of HTTP method)", async () => {
      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("widget_booking");
      guard = new FeatureGuard(
        makeFlags(async () => false),
        reflector,
      );
      await expect(
        guard.canActivate(
          ctx({
            method: "POST",
            subscriptionStatus: "active",
            tenantId: "t1",
            hasUser: true,
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: "FEATURE_NOT_IN_PLAN" },
      });
    });
  });

  it("passes the correct tenantId to FeatureFlagService.isEnabled", async () => {
    const isEnabled = jest.fn(async () => true);
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("whatsapp_send");
    guard = new FeatureGuard({ isEnabled } as any, reflector);
    await guard.canActivate(
      ctx({ method: "POST", tenantId: "tenant-xyz", hasUser: true }),
    );
    expect(isEnabled).toHaveBeenCalledWith("tenant-xyz", "whatsapp_send");
  });
});