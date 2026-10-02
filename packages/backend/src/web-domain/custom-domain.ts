import { Injectable } from "@nestjs/common";
import { Resolver } from "node:dns/promises";

/**
 * Pure pieces of the custom-domain flow: normalising what the salon types,
 * and deciding from DNS answers whether the domain is really theirs and
 * really points at us.
 *
 * Kept free of Prisma and Nest so the decisions can be tested with a fake
 * resolver: the old module "checked availability" by looking at the suffix
 * (.test/.example were "taken", everything else "available") and "purchased"
 * by flipping a flag, and nothing ever looked at DNS.
 */

/** Label in front of the salon's domain that carries the ownership TXT record. */
export const TXT_LABEL = "_kiraroom";
/** Prefix of the TXT value, so the record says what it is for. */
export const TXT_PREFIX = "kiraroom-verify=";

const HOST_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * What the salon typed, reduced to a bare lower-case host name, or null when
 * it is not one.
 *
 * People paste "https://www.misalon.com/" or "WWW.MiSalon.com." -- all the
 * same host. `new URL` also converts an accented domain (peluquería.es) to
 * the punycode form DNS and the Host header actually carry.
 */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) raw = `http://${raw}`;
  let host: string;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    host = url.hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (!HOST_RE.test(host)) return null;
  return host;
}

/** Last two labels: "app.kiraroom.net" -> "kiraroom.net". */
export function registrableGuess(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/**
 * True when `domain` is the platform's own (the CNAME target or anything
 * under its parent domain). A salon must not be able to claim
 * app.kiraroom.net or another salon's *.kiraroom.net name.
 */
export function isPlatformDomain(domain: string, target: string): boolean {
  const root = registrableGuess(target);
  return (
    domain === target ||
    domain === root ||
    domain.endsWith(`.${root}`) ||
    // The production domain, whatever the target is in this environment.
    domain === "kiraroom.net" ||
    domain.endsWith(".kiraroom.net") ||
    domain === "localhost" ||
    domain.endsWith(".localhost")
  );
}

export function txtRecordName(domain: string): string {
  return `${TXT_LABEL}.${domain}`;
}

export function txtRecordValue(token: string): string {
  return `${TXT_PREFIX}${token}`;
}

/** The subset of node:dns/promises the check uses, so tests can fake it. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
}

// One shape rather than a union: narrowing on `ok` needs strictNullChecks,
// which the jest config does not enable.
export type DnsCheck = { ok: boolean; error?: string };

const bare = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");

/** A lookup that found nothing is an empty answer, not a failure of the check. */
async function orEmpty<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch {
    return [];
  }
}

/**
 * Both conditions for serving a salon's page on `domain`:
 *
 *  1. Ownership: `_kiraroom.<domain>` has a TXT record with this salon's
 *     token. Pointing a domain at us proves nothing about WHICH salon it
 *     belongs to; without this, any salon could claim a domain that another
 *     salon had already pointed here.
 *  2. Routing: the domain reaches the platform, either as a CNAME to the
 *     target host or with A records that are all the target's addresses
 *     (the only option at a domain's apex, where a CNAME is not allowed).
 *     "All": with one A record elsewhere, some visitors would land on the
 *     old host.
 */
export async function checkDomainDns(
  dns: DnsResolver,
  domain: string,
  token: string,
  target: string,
): Promise<DnsCheck> {
  const txtName = txtRecordName(domain);
  const expected = txtRecordValue(token);
  const txt = await orEmpty(dns.resolveTxt(txtName));
  // A TXT record longer than 255 bytes arrives split in chunks.
  const values = txt.map((chunks) => chunks.join("").trim());
  if (!values.includes(expected)) {
    return {
      ok: false,
      error:
        values.length === 0
          ? `No encontramos el registro TXT en ${txtName}. Si acabas de crearlo, la propagación puede tardar hasta unas horas.`
          : `El registro TXT de ${txtName} no tiene el valor esperado (${expected}).`,
    };
  }

  const wanted = bare(target);
  const cnames = (await orEmpty(dns.resolveCname(domain))).map(bare);
  if (cnames.includes(wanted)) return { ok: true };

  const [domainIps, targetIps] = await Promise.all([
    orEmpty(dns.resolve4(domain)),
    orEmpty(dns.resolve4(wanted)),
  ]);
  if (
    domainIps.length > 0 &&
    targetIps.length > 0 &&
    domainIps.every((ip) => targetIps.includes(ip))
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      cnames.length > 0
        ? `${domain} apunta a ${cnames.join(", ")}, no a ${wanted}. Cambia el registro CNAME para que apunte a ${wanted}.`
        : domainIps.length > 0
          ? `${domain} apunta a ${domainIps.join(", ")}, que no es ${wanted}${targetIps.length ? ` (${targetIps.join(", ")})` : ""}.`
          : `${domain} todavía no apunta a ningún sitio. Crea el registro CNAME hacia ${wanted}.`,
  };
}

/**
 * The real resolver. Short timeout: this runs inside a request from the
 * panel, and an unanswered lookup must come back as "not found yet", not
 * hang the button.
 */
@Injectable()
export class DnsLookup implements DnsResolver {
  private readonly resolver = new Resolver({ timeout: 3000, tries: 2 });

  resolveTxt(name: string) {
    return this.resolver.resolveTxt(name);
  }
  resolveCname(name: string) {
    return this.resolver.resolveCname(name);
  }
  resolve4(name: string) {
    return this.resolver.resolve4(name);
  }
}
