import { imageVersion, parseImageDataUrl, publicImageUrl } from "./public-images";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("public images", () => {
  it("reads the image types the panel uploads out of a data: URL", () => {
    expect(parseImageDataUrl(`data:image/png;base64,${b64("a")}`)).toEqual({ contentType: "image/png", body: Buffer.from("a") });
    expect(parseImageDataUrl(`data:image/jpg;base64,${b64("a")}`)?.contentType).toBe("image/jpeg");
    expect(parseImageDataUrl(`data:image/svg+xml;base64,${b64("<svg/>")}`)?.contentType).toBe("image/svg+xml");
  });

  it("serves nothing that is not an image", () => {
    expect(parseImageDataUrl(`data:text/html;base64,${b64("<p>")}`)).toBeNull();
    expect(parseImageDataUrl("data:image/png,raw")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseImageDataUrl("https://cdn.example/a.png")).toBeNull();
    expect(parseImageDataUrl(null)).toBeNull();
  });

  it("gives a web URL as stored, a data: URL as the versioned API path, else null", () => {
    expect(publicImageUrl("t1", "logo", "https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    const value = `data:image/webp;base64,${b64("w")}`;
    expect(publicImageUrl("t1", "cover", value)).toBe(`/public-site/image/t1/cover?v=${imageVersion(value)}`);
    expect(publicImageUrl("t1", "cover", "ftp://files.example/a.png")).toBeNull();
    expect(publicImageUrl("t1", "logo", "")).toBeNull();
  });

  it("changes the version with the image", () => {
    expect(imageVersion("a")).not.toBe(imageVersion("b"));
    expect(imageVersion("a")).toHaveLength(16);
  });
});
