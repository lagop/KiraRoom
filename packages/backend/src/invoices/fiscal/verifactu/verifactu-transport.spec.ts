import { BadRequestException } from "@nestjs/common";
import { generateKeyPairSync } from "crypto";
import { createServer, Server } from "https";
import { AddressInfo } from "net";
import * as forge from "node-forge";
import { openPkcs12 } from "./certificate";
import { VerifactuTransport } from "./transport";

/**
 * The certificate and the transport. The old upload opened every .p12 with
 * an empty password, and the old "real" transport posted with plain fetch,
 * without any client certificate, so the AEAT could not have identified the
 * sender.
 */

function selfSigned(commonName: string, serialNumber?: string, days = 365, ip?: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" }).toString()) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000);
  const attrs: forge.pki.CertificateField[] = [{ name: "commonName", value: commonName }];
  if (serialNumber) attrs.push({ name: "serialNumber", value: serialNumber });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  if (ip) cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 7, ip }] }]);
  cert.sign(key, forge.md.sha256.create());
  return { key, cert, keyPem: forge.pki.privateKeyToPem(key), certPem: forge.pki.certificateToPem(cert) };
}

function p12(keyAndCert: { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate }, password: string, algorithm: "3des" | "aes256") {
  const asn1 = forge.pkcs12.toPkcs12Asn1(keyAndCert.key, [keyAndCert.cert], password, { algorithm });
  return forge.util.encode64(forge.asn1.toDer(asn1).getBytes());
}

describe("opening the salon's certificate", () => {
  const salon = selfSigned("SALON PRUEBA - 12345678Z", "IDCES-12345678Z");

  it.each(["3des", "aes256"] as const)("opens a %s PKCS#12 with its password", (algorithm) => {
    const opened = openPkcs12(p12(salon, "s3cret-pw", algorithm), "s3cret-pw");
    expect(opened.keyPem).toContain("PRIVATE KEY");
    expect(opened.certPem).toContain("BEGIN CERTIFICATE");
    expect(opened.nif).toBe("12345678Z");
    expect(opened.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a wrong password, saying so", () => {
    expect(() => openPkcs12(p12(salon, "right", "aes256"), "wrong")).toThrow(/contraseña/);
  });

  it("refuses something that is not a certificate", () => {
    expect(() => openPkcs12(Buffer.from("hello").toString("base64"), "x")).toThrow(BadRequestException);
  });

  it("refuses an expired certificate", () => {
    const old = selfSigned("CADUCADO", undefined, -1);
    expect(() => openPkcs12(p12(old, "pw", "aes256"), "pw")).toThrow(/caducó/);
  });
});

describe("mutual TLS transport", () => {
  const serverId = selfSigned("aeat-test", undefined, 365, "127.0.0.1");
  const client = selfSigned("SALON PRUEBA - 12345678Z", "IDCES-12345678Z");
  let server: Server;
  let url: string;
  let seen: { clientCN?: string; contentType?: string; soapAction?: string; body?: string } = {};

  beforeAll(async () => {
    server = createServer(
      { key: serverId.keyPem, cert: serverId.certPem, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        const peer = (req.socket as any).getPeerCertificate();
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen = {
            clientCN: peer?.subject?.CN,
            contentType: req.headers["content-type"],
            soapAction: req.headers["soapaction"] as string,
            body,
          };
          if (!peer?.subject) {
            res.writeHead(403).end("certificate required");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/xml" }).end("<ok/>");
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("presents the salon's certificate and posts SOAP 1.1 with an empty SOAPAction", async () => {
    const opened = openPkcs12(p12(client, "pw", "3des"), "pw");
    // The test server is trusted the way an extra AEAT CA would be.
    const reply = await new VerifactuTransport().post(
      url,
      "<soap>ñ</soap>",
      { key: opened.keyPem, cert: opened.certPem, type: "personal" },
      { ca: serverId.certPem },
    );
    expect(reply).toEqual({ status: 200, body: "<ok/>" });
    expect(seen.clientCN).toBe("SALON PRUEBA - 12345678Z");
    expect(seen.contentType).toBe("text/xml; charset=UTF-8");
    expect(seen.soapAction).toBe('""');
    expect(seen.body).toBe("<soap>ñ</soap>");
  });

  it("refuses a server it does not trust", async () => {
    await expect(
      new VerifactuTransport().post(url, "<x/>", { key: client.keyPem, cert: client.certPem, type: "personal" }),
    ).rejects.toThrow(/self-signed|certificate/);
  });

  it("gives up after the timeout instead of hanging", async () => {
    const silent = createServer({ key: serverId.keyPem, cert: serverId.certPem }, () => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as AddressInfo).port;
    await expect(
      new VerifactuTransport().post(`https://127.0.0.1:${port}/`, "<x/>", { key: client.keyPem, cert: client.certPem, type: "personal" }, { timeoutMs: 300, ca: serverId.certPem }),
    ).rejects.toThrow(/Sin respuesta de la AEAT/);
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  });
});
