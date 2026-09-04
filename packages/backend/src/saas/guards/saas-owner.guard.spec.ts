/**
 * SaasOwnerGuard is intentionally simple: it only needs to read metadata
 * via Reflector and inspect the `user.role` on the request. We can test
 * it without `@nestjs/testing` by instantiating the guard and Reflector
 * directly. The plan keeps zero new runtime deps; no @nestjs/testing
 * import is required.
 */
import { Reflector } from "@nestjs/core";
import { ExecutionContext } from "@nestjs/common";
import { SaasOwnerGuard } from "./saas-owner.guard";
import { SAAS_OWNER_KEY } from "../decorators/saas-owner.decorator";

function ctx(role?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : undefined }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe("SaasOwnerGuard", () => {
  let guard: SaasOwnerGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new SaasOwnerGuard(reflector);
  });

  it("passes through when @SaasOwner() is not set", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    expect(guard.canActivate(ctx("owner"))).toBe(true);
    expect(guard.canActivate(ctx("admin"))).toBe(true);
    expect(guard.canActivate(ctx(undefined))).toBe(true);
  });

  it("allows saas_owner when @SaasOwner() is set", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(true);
    expect(guard.canActivate(ctx("saas_owner"))).toBe(true);
  });

  it("rejects every other role when @SaasOwner() is set", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(true);
    for (const role of ["owner", "admin", "staff", "client", undefined]) {
      expect(guard.canActivate(ctx(role))).toBe(false);
    }
  });

  it("looks up metadata under SAAS_OWNER_KEY on the handler + class", () => {
    const spy = jest
      .spyOn(reflector, "getAllAndOverride")
      .mockImplementation((key: string | symbol) =>
        key === SAAS_OWNER_KEY ? true : undefined,
      );
    expect(guard.canActivate(ctx("saas_owner"))).toBe(true);
    expect(spy).toHaveBeenCalledWith(SAAS_OWNER_KEY, [undefined, undefined]);
  });
});
