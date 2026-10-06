import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { SUBDOMAIN_ROUTER_PRIORITY, traefikDynamicConfig } from "./traefik-provider";
import { TraefikProviderController } from "./traefik-provider.controller";

/**
 * What Traefik's HTTP provider gets: a router (and so a certificate) for each
 * verified salon domain and, once a DNS-challenge resolver exists, one
 * wildcard router for <slug>.kiraroom.net. Only verified domains appear, so a
 * stranger's Host header never makes Traefik ask Let's Encrypt for anything.
 */

const settings = {
  service: "kiraroom-app@docker",
  entryPoint: "websecure",
  certResolver: "mytlschallenge",
  dnsCertResolver: "hostinger",
  subdomainBase: "kiraroom.net",
  traefikMajor: 3,
};

describe("traefikDynamicConfig", () => {
  it("routes each verified domain to the frontend with its own certificate", () => {
    const http = traefikDynamicConfig(["reservas.salonluna.es", "reservas.salonluna.es", "citas.otro.com"], {
      ...settings,
      dnsCertResolver: "",
    }).http!;
    expect(Object.keys(http.routers).sort()).toEqual([
      "kiraroom-domain-citas_otro_com",
      "kiraroom-domain-reservas_salonluna_es",
    ]);
    expect(http.routers["kiraroom-domain-reservas_salonluna_es"]).toEqual({
      rule: "Host(`reservas.salonluna.es`)",
      entryPoints: ["websecure"],
      service: "kiraroom-app@docker",
      tls: { certResolver: "mytlschallenge" },
    });
  });

  it("adds the wildcard router only with a DNS resolver and a base", () => {
    // Nothing to route: an empty configuration, since Traefik rejects an
    // empty "routers" ("routers cannot be a standalone element").
    expect(traefikDynamicConfig([], { ...settings, dnsCertResolver: "" })).toEqual({});
    expect(traefikDynamicConfig([], { ...settings, subdomainBase: "" })).toEqual({});

    const router = traefikDynamicConfig([], settings).http!.routers["kiraroom-salon-subdomains"];
    expect(router.rule).toBe("HostRegexp(`^[a-z0-9-]+\\.kiraroom\\.net$`)");
    expect(router.priority).toBe(SUBDOMAIN_ROUTER_PRIORITY);
    expect(router.tls).toEqual({
      certResolver: "hostinger",
      domains: [{ main: "kiraroom.net", sans: ["*.kiraroom.net"] }],
    });
  });

  it("writes the Traefik v2 syntax when asked", () => {
    const router = traefikDynamicConfig([], { ...settings, traefikMajor: 2 }).http!.routers["kiraroom-salon-subdomains"];
    expect(router.rule).toBe("HostRegexp(`{salon:[a-z0-9-]+}.kiraroom.net`)");
  });

  it("keeps the wildcard below the apex redirector (priority 10 in docker-compose.prod.yml)", () => {
    expect(SUBDOMAIN_ROUTER_PRIORITY).toBeLessThan(10);
  });
});

describe("TraefikProviderController", () => {
  function controller(token: string | undefined) {
    const webDomain: any = { traefikConfig: jest.fn(async () => ({ http: { routers: {} } })) };
    const config: any = { get: (k: string) => (k === "TRAEFIK_PROVIDER_TOKEN" ? token : undefined) };
    const c = new TraefikProviderController(webDomain, config);
    (c as any).logger = { warn: jest.fn() };
    return { c, webDomain };
  }
  const req = (auth?: string): any => ({ headers: auth ? { authorization: auth } : {} });

  it("does not exist without a token configured", async () => {
    await expect(controller(undefined).c.dynamic(req("Bearer x"))).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses a wrong or missing token", async () => {
    const { c, webDomain } = controller("s3cret-token");
    await expect(c.dynamic(req("Bearer nope"))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(c.dynamic(req())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(webDomain.traefikConfig).not.toHaveBeenCalled();
  });

  it("answers with the header or the query token", async () => {
    const { c } = controller("s3cret-token");
    await expect(c.dynamic(req("Bearer s3cret-token"))).resolves.toEqual({ http: { routers: {} } });
    await expect(c.dynamic(req(), "s3cret-token")).resolves.toEqual({ http: { routers: {} } });
  });
});
