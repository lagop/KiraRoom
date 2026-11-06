import { executeSalonTool, SalonToolsService } from "./tools/salon-tools";
import { resolveIds } from "./tools/resolve-ids";
import { publicProfessionalNames, publicNameOf } from "../public-site/public-professional";
import { publicBooking } from "../appointments/appointment-response";

/**
 * Audit 2026-11-06: "Mostrar en la web: oculta" promises that a professional
 * is not named. The receptionist (tools, error lists, booking answers) and the
 * public booking response named her anyway. They now use the page's names.
 */
const TENANT = "t-1";
const row = (id: string, firstName: string, lastName: string, webNameDisplay: string, extra: Record<string, unknown> = {}) => ({
  id, tenantId: TENANT, isActive: true, firstName, lastName, webNameDisplay, webShowPhoto: true,
  position: "Colorista", bio: "Bio pública", specialties: ["color"], yearsExperience: 9, languages: ["es"],
  isOwner: false, profileImage: null, services: [], ...extra,
});
const ROWS = [
  row("p1", "Ana", "García", "full", { isOwner: true }),
  row("p2", "Berta", "Ruiz Pérez", "initial"),
  row("p3", "Carmen", "Secreta", "hidden", { bio: "Vive en Telde" }),
  row("p4", "Dora", "Oculta", "hidden", { bio: "Vive en Telde" }),
];

function prisma() {
  return {
    professional: {
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let r = ROWS.filter((p) => p.tenantId === where.tenantId && (where.isActive === undefined || p.isActive === where.isActive));
        if (Array.isArray(orderBy) && orderBy[0]?.firstName === "asc") r = [...r].sort((a, b) => a.firstName.localeCompare(b.firstName));
        return r;
      }),
      findFirst: jest.fn(async ({ where }: any) => ROWS.find((p) => p.id === where.id) ?? null),
    },
    service: { findMany: jest.fn(async () => []) },
    tenant: { findUnique: jest.fn(async () => null) },
    salonLocation: { findMany: jest.fn(async () => []) },
    professionalLocation: { findMany: jest.fn(async () => []) },
  } as any;
}

const REAL = ["Carmen", "Secreta", "Dora", "Oculta", "Vive en Telde", "Pérez"];
const leaks = (value: unknown) => REAL.filter((s) => JSON.stringify(value).includes(s));

describe("hidden professionals are named as the page names them", () => {
  it("numbers them like the salon's page and keeps the others' public form", async () => {
    const names = await publicProfessionalNames(prisma(), TENANT);
    expect(names.get("p1")).toMatchObject({ firstName: "Ana", lastName: "García", hidden: false });
    expect(names.get("p2")).toMatchObject({ firstName: "Berta", lastName: "R.", hidden: false });
    expect(names.get("p3")).toMatchObject({ firstName: "Profesional 1", hidden: true });
    expect(names.get("p4")).toMatchObject({ firstName: "Profesional 2", hidden: true });
  });

  it("list_professionals says nothing about who they are", async () => {
    const out: any = await new SalonToolsService({} as any, {} as any).listProfessionals({ prisma: prisma(), tenantId: TENANT } as any, {});
    const hidden = out.professionals.filter((p: any) => p.fullName.startsWith("Profesional"));
    expect(hidden).toHaveLength(2);
    expect(hidden[0]).toMatchObject({ position: null, bio: null, specialties: [], yearsExperience: null, languages: [] });
    expect(leaks(out)).toEqual([]);
    expect(out.professionals.map((p: any) => p.fullName)).toContain("Berta R.");
  });

  it("the error list of an unknown professional names them publicly, and she can be chosen by it", async () => {
    const bad: any = await resolveIds({ prisma: prisma(), tenantId: TENANT } as any, { professionalId: "Nadie" });
    expect(bad.ok).toBe(false);
    expect(leaks(bad.error)).toEqual([]);
    const good: any = await resolveIds({ prisma: prisma(), tenantId: TENANT } as any, { professionalId: "Profesional 2" });
    expect(good).toMatchObject({ ok: true, args: { professionalId: "p4" } });
  });

  it("the public booking answer and the single-row name", () => {
    const answer = publicBooking({ id: "a", professional: ROWS[2] });
    expect(answer.professional).toEqual({ id: "p3", firstName: "Profesional", lastName: "" });
    expect(publicNameOf(ROWS[1] as any)).toEqual({ firstName: "Berta", lastName: "R." });
  });

  it("the tool dispatcher exists for the names above", () => {
    expect(typeof executeSalonTool).toBe("function");
  });
});
