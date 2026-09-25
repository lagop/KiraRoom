import { Reflector } from "@nestjs/core";
import { AppController } from "./app.controller";
import { IS_PUBLIC_KEY } from "./auth/decorators/public.decorator";

/**
 * L4: the liveness endpoints must not require a token.
 *
 * They did. `JwtAuthGuard` is a global APP_GUARD, so `/api/v1/ping` answered
 * 401, and the production healthcheck (`wget --spider` against that path)
 * treats 401 as failure. The backend therefore ran for three days marked
 * `unhealthy`; Traefik's Docker provider skips unhealthy containers, so it
 * never registered the router for api.kiraroom.net and the whole API was
 * unreachable behind a default self-signed certificate.
 *
 * Nothing in the code looked broken, which is why this is worth a test: the
 * failure only surfaces when an orchestrator reads the exit code of a probe.
 *
 * Asserted on the metadata the guard reads, rather than by invoking the guard:
 * calling `canActivate` without @Public falls through to passport, which has
 * no strategy registered in a unit test and takes the whole worker down
 * instead of failing the assertion.
 */
describe("liveness endpoints", () => {
  const reflector = new Reflector();

  const isPublic = (handler: (...args: any[]) => unknown): boolean =>
    reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      handler,
      AppController,
    ]) === true;

  it("ping is marked public, so the healthcheck gets 200 and not 401", () => {
    expect(isPublic(AppController.prototype.ping)).toBe(true);
  });

  it("the root health endpoint is marked public", () => {
    expect(isPublic(AppController.prototype.getHealth)).toBe(true);
  });

  it("ping returns a body a probe can read", () => {
    expect(new AppController().ping()).toBe("pong");
  });

  it("the health endpoint reports ok", () => {
    expect(new AppController().getHealth()).toMatchObject({ status: "ok" });
  });
});
