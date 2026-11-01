import { BadRequestException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import {
  birthDateRange,
  clientListOrderBy,
  clientSearchSql,
  likeContains,
  normaliseSearchText,
  parseClientListQuery,
  phoneDigitVariants,
} from "./client-search";
import { ClientsController } from "./clients.controller";
import { ClientsService } from "./clients.service";
import { CLIENT_LIST_SELECT } from "./client-select";

describe("client list search: normalising what was typed", () => {
  it("lowercases, drops accents and collapses spaces", () => {
    expect(normaliseSearchText("  Pérez  GARCÍA ")).toBe("perez garcia");
    expect(normaliseSearchText("Núñez Çelik")).toBe("nunez celik");
    expect(normaliseSearchText(undefined)).toBe("");
  });

  it("searches the phone by its digits, with and without the 34 prefix", () => {
    expect(phoneDigitVariants("+34 600-111 222")).toEqual(["34600111222", "600111222"]);
    expect(phoneDigitVariants("0034 600 111 222")).toEqual(["0034600111222", "600111222"]);
    expect(phoneDigitVariants("600 11")).toEqual(["60011"]);
    // Too few digits to be a phone search.
    expect(phoneDigitVariants("ana 2")).toEqual([]);
    expect(phoneDigitVariants("ana")).toEqual([]);
  });

  it("LIKE wildcards typed in the search are literal", () => {
    expect(likeContains("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });
});

describe("client list search: the SQL", () => {
  it("matches name (both orders), email and phone digits, all as bound values, inside the tenant", () => {
    const sql = clientSearchSql("t1", { search: "perez", phoneDigits: ["600111"] });
    expect(sql.text).toContain('"tenantId" = $1');
    expect(sql.text).toContain(`"firstName" || ' ' || "lastName"`);
    expect(sql.text).toContain(`"lastName" || ' ' || "firstName"`);
    expect(sql.text).toContain('coalesce("email", \'\')');
    expect(sql.text).toContain("translate(lower(");
    expect(sql.text).toContain("regexp_replace(coalesce(\"phone\", ''), '[^0-9]', '', 'g') LIKE");
    // Nothing typed reaches the SQL text.
    expect(sql.text).not.toContain("perez");
    expect(sql.text).not.toContain("600111");
    expect(sql.values).toContain("t1");
    expect(sql.values).toContain("%perez%");
    expect(sql.values).toContain("%600111%");
  });

  it("a digits-only search does not look at names", () => {
    const sql = clientSearchSql("t1", { search: "", phoneDigits: ["600111"] });
    expect(sql.text).not.toContain("firstName");
    expect(sql.text).toContain("regexp_replace");
  });
});

describe("client list search: parameters", () => {
  it("defaults: page 1, 25 a page, newest first", () => {
    expect(parseClientListQuery({ page: "1" })).toEqual({
      page: 1,
      pageSize: 25,
      search: "",
      phoneDigits: [],
      status: undefined,
      sort: "createdAt",
      dir: "desc",
    });
  });

  it("caps the page size, checks the status, ignores an unknown sort", () => {
    const q = parseClientListQuery({ page: "3", pageSize: "1000", status: "blocked", sort: "passwordHash", q: "Pérez" });
    expect(q).toMatchObject({ page: 3, pageSize: 100, status: "blocked", sort: "createdAt", search: "perez" });
    expect(parseClientListQuery({ page: "1", sort: "lastName" }).dir).toBe("asc");
    expect(() => parseClientListQuery({ page: "0" })).toThrow(BadRequestException);
    expect(() => parseClientListQuery({ page: "abc" })).toThrow(BadRequestException);
    expect(() => parseClientListQuery({ page: "1", status: "deleted" })).toThrow(BadRequestException);
  });

  it("sorts by the column, then a stable tie-break", () => {
    expect(clientListOrderBy({ sort: "firstName", dir: "asc" })).toEqual([
      { firstName: "asc" },
      { lastName: "asc" },
      { id: "asc" },
    ]);
    expect(clientListOrderBy({ sort: "createdAt", dir: "desc" })).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });
});

describe("age filter: birth-date bounds", () => {
  const now = new Date("2026-11-01T10:00:00Z");
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const inRange = (born: string, min?: number, max?: number) => {
    const r = birthDateRange(now, min, max)!;
    const b = d(born).getTime();
    return (r.lt === undefined || b < r.lt.getTime()) && (r.gte === undefined || b >= r.gte.getTime());
  };

  it("no ages, no bound", () => {
    expect(birthDateRange(now)).toBeUndefined();
  });

  it("age ≥ 18 takes whoever turns 18 today, not tomorrow", () => {
    expect(inRange("2008-11-01", 18)).toBe(true);
    expect(inRange("2008-11-02", 18)).toBe(false);
    expect(inRange("1970-01-01", 18)).toBe(true);
  });

  it("age ≤ 30 leaves out whoever turns 31 today", () => {
    // Turns 31 today: 31, not ≤ 30. The old `gte` bound took her.
    expect(inRange("1995-11-01", undefined, 30)).toBe(false);
    // Turns 31 tomorrow: still 30.
    expect(inRange("1995-11-02", undefined, 30)).toBe(true);
    // Turned 30 today.
    expect(inRange("1996-11-01", undefined, 30)).toBe(true);
  });

  it("min = max is a single age", () => {
    expect(inRange("1996-11-01", 30, 30)).toBe(true);
    expect(inRange("1996-11-02", 30, 30)).toBe(false);
    expect(inRange("1995-11-01", 30, 30)).toBe(false);
    expect(inRange("1995-11-02", 30, 30)).toBe(true);
  });

  it("a birth date stored with a time of day still counts on its day", () => {
    const r = birthDateRange(now, 18)!;
    expect(new Date("2008-11-01T18:30:00Z").getTime()).toBeLessThan(r.lt!.getTime());
  });

  it("29 February: the same day in a common year is the 28th", () => {
    const leap = new Date("2028-02-29T09:00:00Z");
    // 2010-02-28 turned 18 on 2028-02-28; 2010-03-01 turns 18 tomorrow.
    const r = birthDateRange(leap, 18)!;
    expect(d("2010-02-28").getTime()).toBeLessThan(r.lt!.getTime());
    expect(d("2010-03-01").getTime()).toBeGreaterThanOrEqual(r.lt!.getTime());
  });

  it("the campaign filter uses these bounds", async () => {
    const calls: any[] = [];
    const prisma: any = { client: { findMany: async (args: any) => (calls.push(args), []) } };
    await new ClientsService(prisma).findAllWithFilters("t1", { minAge: 18, maxAge: 30 });
    expect(calls[0].where.dateOfBirth).toEqual(birthDateRange(new Date(), 18, 30));
  });
});

describe("GET /clients", () => {
  function setup(ids: string[] = ["c1", "c2"], professional: { id: string } | null = { id: "p1" }) {
    const calls: Record<string, any[]> = { raw: [], findMany: [], count: [] };
    const prisma: any = {
      $queryRaw: async (sql: any) => (calls.raw.push(sql), ids.map((id) => ({ id }))),
      client: {
        findMany: async (args: any) => (calls.findMany.push(args), [{ id: "c1" }]),
        count: async (args: any) => (calls.count.push(args), 41),
      },
    };
    const professionals: any = { getProfessionalByUserId: async () => professional };
    const controller = new ClientsController(new ClientsService(prisma), professionals);
    return { controller, calls };
  }
  const owner = { id: "u0", tenantId: "t1", role: UserRole.owner };
  const staff = { id: "u1", tenantId: "t1", role: UserRole.staff };

  it("without `page`: the whole list as an array, as before", async () => {
    const { controller, calls } = setup();
    expect(await controller.findAll(owner)).toEqual([{ id: "c1" }]);
    expect(calls.findMany[0].skip).toBeUndefined();
    expect(calls.raw).toHaveLength(0);
  });

  it("with `page`: one page, its total, and the list selection", async () => {
    const { controller, calls } = setup();
    const res = await controller.findAll(owner, "2", "20", undefined, "active", "firstName", "asc");
    expect(res).toEqual({ data: [{ id: "c1" }], total: 41, page: 2, pageSize: 20, totalPages: 3 });
    expect(calls.raw).toHaveLength(0);
    expect(calls.findMany[0]).toMatchObject({
      where: { tenantId: "t1", status: "active" },
      select: CLIENT_LIST_SELECT,
      skip: 20,
      take: 20,
    });
    expect(calls.count[0].where).toEqual(calls.findMany[0].where);
  });

  it("a search narrows to the ids the SQL matched, still within the staff member's clients", async () => {
    const { controller, calls } = setup(["c1", "c2"]);
    await controller.findAll(staff, "1", undefined, "pérez");
    expect(calls.raw).toHaveLength(1);
    expect(calls.raw[0].values).toContain("%perez%");
    expect(calls.findMany[0].where).toEqual({
      tenantId: "t1",
      appointments: { some: { professionalId: "p1" } },
      id: { in: ["c1", "c2"] },
    });
  });

  it("a search with no match answers an empty page without listing", async () => {
    const { controller, calls } = setup([]);
    const res = await controller.findAll(owner, "1", "25", "zzz");
    expect(res).toEqual({ data: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
    expect(calls.findMany).toHaveLength(0);
  });

  it("a staff user with no professional record gets an empty page", async () => {
    const { controller, calls } = setup(["c1"], null);
    expect(await controller.findAll(staff, "1")).toEqual({ data: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
    expect(calls.raw).toHaveLength(0);
  });
});
