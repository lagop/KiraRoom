import { readFileSync } from "fs";
import { join } from "path";
import { validateXML } from "xmllint-wasm";

/**
 * Test helper (not a suite: Jest runs *.spec.ts; the build skips *.test.ts).
 * Validates a document against the official AEAT schemas vendored in ./xsd,
 * offline, and returns the error messages (none = valid).
 */
const XSD_DIR = join(__dirname, "xsd");
const readXsd = (name: string) =>
  readFileSync(join(XSD_DIR, name), "utf8")
    // Offline: the signature schema is imported by absolute URL, and its DTD is not needed.
    .replace("http://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd", "xmldsig-core-schema.xsd")
    .replace(/<!DOCTYPE[\s\S]*?\]>/, "");

export async function validateAgainstXsd(xml: string, root: "SuministroLR.xsd" | "RespuestaSuministro.xsd"): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: "doc.xml", contents: xml }],
    schema: [{ fileName: root, contents: readXsd(root) }],
    preload: ["SuministroLR.xsd", "SuministroInformacion.xsd", "xmldsig-core-schema.xsd"]
      .filter((f) => f !== root)
      .map((f) => ({ fileName: f, contents: readXsd(f) })),
  });
  return result.errors.map((e) => e.message);
}
