import { facebookProfileUrl, instagramProfileUrl, socialLinkInput } from "./social-links";

/**
 * The salon's Instagram and Facebook, typed on its general settings page the
 * way the owner has them to hand, stored as one canonical profile URL each.
 */

describe("instagramProfileUrl", () => {
  it.each([
    ["@salonana", "https://www.instagram.com/salonana/"],
    ["salonana", "https://www.instagram.com/salonana/"],
    ["  salon.ana_  ", "https://www.instagram.com/salon.ana_/"],
    ["instagram.com/salonana", "https://www.instagram.com/salonana/"],
    ["https://www.instagram.com/salonana/?igsh=MWx0", "https://www.instagram.com/salonana/"],
    ["http://m.instagram.com/salonana", "https://www.instagram.com/salonana/"],
  ])("%s -> %s", (input, url) => {
    expect(instagramProfileUrl(input)).toBe(url);
    // Canonical: saving it again changes nothing.
    expect(instagramProfileUrl(url)).toBe(url);
  });

  it.each([
    "https://www.instagram.com/p/C1abc/",
    "https://www.instagram.com/p/",
    "https://instagram.com/",
    "https://evil.example/salonana",
    "salon ana",
    "a".repeat(31),
  ])("%s names no profile", (input) => {
    expect(instagramProfileUrl(input)).toBeNull();
  });
});

describe("facebookProfileUrl", () => {
  it.each([
    ["salonana", "https://www.facebook.com/salonana"],
    ["@Salon.Ana", "https://www.facebook.com/Salon.Ana"],
    ["facebook.com/salonana/", "https://www.facebook.com/salonana"],
    ["https://m.facebook.com/salonana?ref=bookmarks", "https://www.facebook.com/salonana"],
    ["https://www.facebook.com/profile.php?id=100012345678", "https://www.facebook.com/profile.php?id=100012345678"],
  ])("%s -> %s", (input, url) => {
    expect(facebookProfileUrl(input)).toBe(url);
    expect(facebookProfileUrl(url)).toBe(url);
  });

  it.each([
    "https://www.facebook.com/sharer/sharer.php?u=x",
    "https://www.facebook.com/sharer.php",
    "https://www.facebook.com/profile.php",
    "https://evil.example/salonana",
    "javascript:alert(1)",
  ])("%s names no page", (input) => {
    expect(facebookProfileUrl(input)).toBeNull();
  });
});

describe("socialLinkInput", () => {
  const input = socialLinkInput(instagramProfileUrl);
  it("blank or null clears the field; a profile is canonical; the rest is left as sent", () => {
    expect(input("")).toBeNull();
    expect(input("   ")).toBeNull();
    expect(input(null)).toBeNull();
    expect(input(undefined)).toBeUndefined();
    expect(input(42)).toBe(42);
    expect(input("@salonana")).toBe("https://www.instagram.com/salonana/");
    expect(input("https://evil.example/x")).toBe("https://evil.example/x");
  });
});
