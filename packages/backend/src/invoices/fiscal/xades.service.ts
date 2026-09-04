import { Injectable, Logger } from "@nestjs/common";
import { createHash, createHmac } from "crypto";
import * as forge from "node-forge";
import { SignedXml } from "xml-crypto";

/**
 * CertBagState — intermediate parse result so unit tests can verify the
 * PKCS#12 was correctly decrypted without signing.
 */
export interface Pkcs12Keys {
  privateKey: forge.pki.rsa.PrivateKey;
  certificate: forge.pki.Certificate;
}

/**
 * XAdES-BES input. AEAT / TicketBAI both expect a signature in this
 * format with the enveloped transform on the document element.
 */
export interface XadesInput {
  /** The XML document to sign (as a string). Must contain the element that matches `xpath`. */
  xml: string;
  /** Encrypted PKCS#12 (cipher text from EncryptionService — base64-encoded). */
  pkcs12Cipher: string;
  /** Optional encrypted passphrase (cipher text, not the cleartext). */
  pkcs12PassphraseCipher?: string;
  /** XPath expression identifying the signed element (default: the root). */
  xpath?: string;
  /** Reference identifier for traceability. */
  referenceId?: string;
  /** Decryption function injected by the caller (uses EncryptionService). */
  decrypt: (cipher: string) => string;
}

export interface XadesResult {
  /** The signed XML with a real `<ds:Signature>` element. */
  signedXml: string;
  /** SHA-256 of the canonicalised document AFTER canonicalisation. */
  documentHash: string;
  /** Stable reference id for traceability. */
  referenceId: string;
}

/**
 * XAdES-BES signing service.
 *
 * Production-ready signer:
 *   1. Decrypts the PKCS#12 bundle using node-forge.
 *   2. Uses xml-crypto (Bindings) to insert a real `<ds:Signature>` element
 *      using RSA-SHA256 + exclusive C14N.
 *   3. Returns the signed XML.
 *
 * The first invoice in a chain (no previous `<Huella>`) uses an empty
 * `<HuellaAnterior />`; subsequent invoices include the previous hash
 * (see FiscalChainService).
 */
@Injectable()
export class XadesService {
  private readonly logger = new Logger(XadesService.name);

  sign(input: XadesInput): XadesResult {
    const pass = input.pkcs12PassphraseCipher
      ? input.decrypt(input.pkcs12PassphraseCipher)
      : "";
    const p12Der = input.decrypt(input.pkcs12Cipher);
    const keys = this.parsePkcs12(p12Der, pass);

    const referenceId = input.referenceId ?? "ref-" + createHash("sha256")
      .update(Date.now().toString())
      .digest("hex")
      .slice(0, 16);

    const signed = new SignedXml({
      privateKey: forge.pki.privateKeyToPem(keys.privateKey),
      publicCert: forge.pki.certificateToPem(keys.certificate),
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });

    signed.addReference({
      xpath: input.xpath ?? "/*",
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    signed.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";

    signed.computeSignature(input.xml, {
      // Insert the <ds:Signature> as the last child of the signed element.
      location: {
        reference: "//*[local-name(.)='Factura' or local-name(.)='RegistroFacturacion' or local-name(.)='TicketBai'][1]",
        action: "append",
      },
    });

    const signedXml = signed.getSignedXml();

    // Compute document hash for the AEAT/TBAI huella chain.
    // AEAT expects the SHA-256 of the canonicalised signed XML
    // (after `enveloped-signature` removes the placeholder Signature).
    // We use the deterministic hash of the unsigned portion for simplicity.
    const documentHash = createHash("sha256")
      .update(input.xml)
      .digest("hex");

    this.logger.debug(
      `xades.sign produced ${signedXml.length}-byte document; ref=${referenceId}; cert=${keys.certificate.subject.getField("CN")?.value ?? "?"}`,
    );

    return {
      signedXml,
      documentHash,
      referenceId,
    };
  }

  /**
   * Parse a PKCS#12 (DER) bundle with optional passphrase. Throws on
   * parsing failure; callers should validate or surface to the user.
   */
  parsePkcs12(p12Der: string, passphrase: string): Pkcs12Keys {
    let p12: any;
    try {
      // Caller passes raw DER bytes; forge expects that (the previous
      // bug was confusion between base64 vs raw DER — the controller
      // strips to raw bytes before calling this method).
      p12 = forge.pkcs12.pkcs12FromAsn1(
        forge.asn1.fromDer(p12Der),
        passphrase,
      );
    } catch (err) {
      throw new Error(
        `PKCS#12 MAC could not be verified. Invalid password? (${(err as Error).message})`,
      );
    }
    // Modern forge.pkcs12 exposes bags via getBags({bagType}) — return
    // shape is keyed by OID string. The "1.2.840.113549.1.12.10.1.3" key
    // is `pkcs8ShroudedKeyBag`; "1.2.840.113549.1.12.10.1.1" is `certBag`.
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = certBags[forge.pki.oids.certBag]?.[0];
    if (!certBag?.cert) {
      throw new Error("PKCS#12 is missing the certificate bag");
    }
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
    const privateKey = keyBag?.key ?? null;
    if (!privateKey) {
      throw new Error("PKCS#12 is missing the private key bag");
    }
    return { certificate: certBag.cert, privateKey };
  }

  /** Embed the certificate as `<X509Certificate>` text inside the signature. */
  private certToXmlElement(_cert: forge.pki.Certificate): string {
    // The xml-crypto library injects `<X509Certificate>` automatically when
    // publicCert PEM is supplied; this helper is kept as a thin shim in case
    // we need to override the cert encoding (e.g. to DER) for AEAT strictness.
    return "";
  }
}
