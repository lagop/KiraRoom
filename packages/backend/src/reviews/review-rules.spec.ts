import {
  LISTABLE_CONSENTS,
  REVIEW_REJECTION_REASONS,
  isRejectionReason,
  salonHour,
  withinSendingHours,
} from "./review-rules";
import { ModerateReviewDto, ReviewsController, ReviewsPublicController, SubmitReviewDto } from "./reviews.controller";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

describe("review rules", () => {
  it("rejection reasons are the four listed ones; the legacy marker is not one", () => {
    expect([...REVIEW_REJECTION_REASONS]).toEqual(["offensive", "personal_data", "off_topic", "spam"]);
    expect(isRejectionReason("spam")).toBe(true);
    expect(isRejectionReason("legacy_unspecified")).toBe(false);
    expect(isRejectionReason("no me gusta")).toBe(false);
    expect(isRejectionReason(undefined)).toBe(false);
  });

  it("only granted and legacy reviews are listed publicly", () => {
    expect(LISTABLE_CONSENTS).toEqual(["granted", "legacy"]);
  });

  it("sends from 09:00 to 20:59 on the salon's own clock", () => {
    // Winter: Madrid is UTC+1, the Canaries UTC+0.
    expect(salonHour(new Date("2026-01-15T07:59:00Z"), "Europe/Madrid")).toBe(8);
    expect(withinSendingHours(new Date("2026-01-15T07:59:00Z"), "Europe/Madrid")).toBe(false);
    expect(withinSendingHours(new Date("2026-01-15T08:00:00Z"), "Europe/Madrid")).toBe(true);
    expect(withinSendingHours(new Date("2026-01-15T19:59:00Z"), "Europe/Madrid")).toBe(true);
    expect(withinSendingHours(new Date("2026-01-15T20:00:00Z"), "Europe/Madrid")).toBe(false);
    expect(withinSendingHours(new Date("2026-01-15T20:30:00Z"), "Atlantic/Canary")).toBe(true);
    expect(withinSendingHours(new Date("2026-01-15T02:00:00Z"), "Atlantic/Canary")).toBe(false);
  });

  it("an unknown zone falls back to Madrid", () => {
    expect(salonHour(new Date("2026-01-15T12:00:00Z"), "Not/AZone")).toBe(13);
    expect(salonHour(new Date("2026-01-15T12:00:00Z"), null)).toBe(13);
  });
});

describe("review bodies", () => {
  const moderate = bodyParser(ReviewsController, "moderate");

  it("rejecting needs a listed reason; approving does not", async () => {
    expect(bodyMetatype(ReviewsController, "moderate")).toBe(ModerateReviewDto);
    await expect(moderate({ action: "approve" })).resolves.toEqual({ action: "approve" });
    await expect(moderate({ action: "reject", reason: "offensive" })).resolves.toEqual({
      action: "reject",
      reason: "offensive",
    });
    await expect(moderate({ action: "reject" })).rejects.toBeDefined();
    await expect(moderate({ action: "reject", reason: "legacy_unspecified" })).rejects.toBeDefined();
    await expect(moderate({ action: "reject", reason: "no me gusta" })).rejects.toBeDefined();
  });

  it("the review answer carries the publish consent as a boolean", async () => {
    expect(bodyMetatype(ReviewsPublicController, "submit")).toBe(SubmitReviewDto);
    const parse = bodyParser(ReviewsPublicController, "submit");
    await expect(parse({ rating: 4, publishConsent: true })).resolves.toMatchObject({ rating: 4, publishConsent: true });
    await expect(parse({ rating: 4, publishConsent: "yes" })).rejects.toBeDefined();
  });
});
