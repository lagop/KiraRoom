import { BadRequestException } from "@nestjs/common";
import { createHash } from "crypto";
import * as forge from "node-forge";

export interface OpenedCertificate {
  keyPem: string;
  /** The certificate, then any intermediates, as PEM. */
  certPem: string;
  fingerprint: string;
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  /** The NIF in the subject's serialNumber (e.g. "IDCES-12345678Z", "VATES-B12345678"), if any. */
  nif: string | null;
}

/**
 * Opens a PKCS#12 (.p12 / .pfx) with its password and extracts the private
 * key and certificate as PEM, which is what mutual TLS needs.
 *
 * Done with node-forge rather than Node's own TLS: many certificates issued
 * in Spain still use the legacy RC2/3DES PKCS#12 encryption, which OpenSSL 3
 * (Node 17 and later) refuses to open. The old upload code also opened the
 * bundle with an empty password, so any protected certificate failed.
 */
export function openPkcs12(pkcs12Base64: string, password: string): OpenedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.decode64(pkcs12Base64.replace(/\s+/g, ""));
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, password);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (/password|mac|invalid/i.test(message)) {
      throw new BadRequestException("La contraseña del certificado no es correcta");
    }
    throw new BadRequestException("El archivo no es un certificado .p12 / .pfx válido");
  }

  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const key = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new BadRequestException("El certificado no incluye la clave privada (hace falta el .p12 / .pfx completo)");

  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c);
  // The certificate whose public key belongs to the private key.
  const leaf = certs.find((c) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey;
    return pub?.n && key.n && pub.n.equals(key.n);
  });
  if (!leaf) throw new BadRequestException("No se encuentra el certificado que corresponde a la clave privada");

  const now = new Date();
  if (leaf.validity.notAfter < now) {
    throw new BadRequestException(`El certificado caducó el ${leaf.validity.notAfter.toLocaleDateString("es-ES")}`);
  }

  const dn = (attrs: forge.pki.CertificateField[]) => attrs.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(", ");
  const serial = leaf.subject.getField({ name: "serialNumber" })?.value as string | undefined;
  const nif = serial ? (/([0-9A-Z]{9})$/.exec(serial.toUpperCase())?.[1] ?? null) : null;
  const leafDer = forge.asn1.toDer(forge.pki.certificateToAsn1(leaf)).getBytes();

  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem: [leaf, ...certs.filter((c) => c !== leaf)].map((c) => forge.pki.certificateToPem(c)).join(""),
    fingerprint: createHash("sha256").update(Buffer.from(leafDer, "binary")).digest("hex"),
    subject: dn(leaf.subject.attributes),
    issuer: dn(leaf.issuer.attributes),
    notBefore: leaf.validity.notBefore,
    notAfter: leaf.validity.notAfter,
    nif,
  };
}
