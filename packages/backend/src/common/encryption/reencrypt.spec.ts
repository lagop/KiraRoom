import { randomBytes } from "crypto";
import { decryptWith, encryptWith, parseMasterKey, reencryptJson, reencryptValue } from "./reencrypt";
import { EncryptionService } from "./encryption.service";

describe("re-encrypting secrets with a new META_TOKEN_ENCRYPTION_KEY", () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);

  it("reads what EncryptionService writes, and writes what it reads", () => {
    const svc = new EncryptionService({ get: (k: string) => (k === "META_TOKEN_ENCRYPTION_KEY" ? oldKey.toString("base64") : undefined) } as any);
    expect(decryptWith(svc.encrypt("from the service"), oldKey)).toBe("from the service");
    expect(svc.decrypt(encryptWith("from the script", oldKey))).toBe("from the script");
  });

  it("moves a value from the old key to the new one, and is idempotent", () => {
    const packed = encryptWith("a secret", oldKey);
    const first = reencryptValue(packed, oldKey, newKey);
    expect(first.outcome).toBe("reencrypted");
    expect(decryptWith(first.value, newKey)).toBe("a secret");
    expect(reencryptValue(first.value, oldKey, newKey)).toEqual({ outcome: "already-new", value: first.value });
  });

  it("leaves values in clear, and reports those neither key opens", () => {
    const plain = ["sk", "live", "notEncrypted123"].join("_");
    expect(reencryptValue(plain, oldKey, newKey).outcome).toBe("not-encrypted");
    expect(reencryptValue(encryptWith("x", randomBytes(32)), oldKey, newKey).outcome).toBe("unreadable");
  });

  it("re-encrypts the channel tokens inside tenants.features", () => {
    const counts = { reencrypted: 0, "already-new": 0, "not-encrypted": 0, unreadable: 0 };
    const features = { multichannel: { telegram: { botTokenEnc: encryptWith("t", oldKey), botId: 1 } }, other: "x" };
    const out: any = reencryptJson(features, oldKey, newKey, "Enc", counts);
    expect(decryptWith(out.multichannel.telegram.botTokenEnc, newKey)).toBe("t");
    expect(out.other).toBe("x");
    expect(counts.reencrypted).toBe(1);
  });

  it("needs keys of 32 bytes", () => {
    expect(() => parseMasterKey("c2hvcnQ=", "NEW_KEY")).toThrow(/32 bytes/);
    expect(parseMasterKey(newKey.toString("base64"), "NEW_KEY")).toEqual(newKey);
  });
});
