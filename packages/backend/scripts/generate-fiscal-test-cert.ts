// scripts/generate-fiscal-test-cert.ts
//
// Generates a self-signed RSA-2048 PKCS#12 certificate used for fiscal
// Spain integration tests (Verifactu / TicketBAI). Run once:
//
//   npx ts-node scripts/generate-fiscal-test-cert.ts
//
// Outputs to `tests/setup/test-cert.p12` and `e2e/fixtures/test-cert.p12`.
// Password (also written to `test-cert.password`): `test-password`.
//
// The certificate is NOT signed by a trusted CA; AEAT / diputaciones will
// reject it. Use only in `FISCAL_E2E_MODE=stub` CI tests where the HTTP
// transport is mocked.

import * as fs from "fs";
import * as crypto from "crypto";
import * as forge from "node-forge";

const PASSWORD = ""; // empty passphrase — pkcs12 is unprotected by default; AEAT certs usually have a passphrase
const VALIDITY_DAYS = 365;

class NodeRandom {
  seedFile() {}
  seedBuffer(_buf: Buffer): void {
    this.seedFile();
  }
  getBytesSync(count: number): string {
    return crypto.randomBytes(count).toString("binary");
  }
  getBytes(count: number, cb?: (bytes: string) => void): string {
    const buf = crypto.randomBytes(count);
    const s = buf.toString("binary");
    if (cb) cb(s);
    return s;
  }
  getBytesHex(count: number): string {
    return crypto.randomBytes(count).toString("hex");
  }
  collectInt(max: number): number {
    return crypto.randomInt(0, max);
  }
  collect(target: number | number[]): string | void {
    if (typeof target === "number") {
      return crypto.randomBytes(target).toString("binary");
    }
    for (let i = 0; i < target.length; i++) {
      target[i] = crypto.randomInt(0, 256);
    }
  }
}

function main(): void {
  forge.random = new NodeRandom() as any;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(
    Date.now() + VALIDITY_DAYS * 24 * 3600 * 1000,
  );
  cert.setSubject([
    { name: "commonName", value: "Kira Studio Test AEAT" },
    { name: "countryName", value: "ES" },
    { name: "organizationName", value: "Kira Studio SL" },
  ]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [cert],
    PASSWORD,
  );
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();

  fs.mkdirSync("tests/setup", { recursive: true });
  fs.mkdirSync("e2e/fixtures", { recursive: true });

  fs.writeFileSync("tests/setup/test-cert.p12", Buffer.from(p12Der, "binary"));
  fs.writeFileSync("e2e/fixtures/test-cert.p12", Buffer.from(p12Der, "binary"));
  fs.writeFileSync("tests/setup/test-cert.password", PASSWORD);
  fs.writeFileSync("e2e/fixtures/test-cert.password", PASSWORD);

  // Also dump the certificate PEM for debugging.
  const certPem = forge.pki.certificateToPem(cert);
  fs.writeFileSync("tests/setup/test-cert.pem", certPem);
  fs.writeFileSync("e2e/fixtures/test-cert.pem", certPem);

  console.log(
    `✓ Generated test-cert.p12 (${p12Der.length} bytes, valid until ${cert.validity.notAfter.toISOString().slice(0, 10)})`,
  );
}

main();
