import { sign } from "jsonwebtoken";
import * as bcrypt from "bcryptjs";
import { JwtService } from "@nestjs/jwt";
import { sessionRevocations } from "./session-revocations";
import { NotificationsGateway } from "../../notifications/notifications.gateway";
import { revokePanelLogin } from "../../professionals/panel-login";
import { AdminProfessionalsService } from "../../admin/professionals/professionals.service";
import { AuthService } from "../auth.service";
import { PublicViewerService } from "../../common/tenancy/public-viewer.service";

/**
 * Ending an account's sessions ends its live connections too.
 *
 * HTTP requests already re-read the account and its tokenVersion on every
 * request (JwtStrategy), so a revoked access token fails on its next call.
 * The notifications socket was checked only when it connected: a team member
 * removed from the salon kept receiving its live notifications until they
 * closed the tab.
 */

process.env.BCRYPT_ROUNDS = "4";
const SECRET = "test-secret-that-is-long-enough-for-hs256";

/** A gateway over fake sockets in rooms; `disconnected` lists what was closed. */
function gateway(rows: { users?: any[]; clients?: any[] } = {}) {
  const disconnected: string[] = [];
  const sockets: Array<{ id: string; rooms: string[]; data: any; disconnect: jest.Mock }> = [];
  const server: any = {
    in: (room: string) => ({
      disconnectSockets: (_close: boolean) => {
        for (const s of sockets.filter((x) => x.rooms.includes(room))) s.disconnect(true);
      },
    }),
    fetchSockets: async () => [...sockets],
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => (rows.users ?? []).find((u) => u.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) => (rows.users ?? []).filter((u) => where.id.in.includes(u.id))),
    },
    client: {
      findUnique: jest.fn(async ({ where }: any) => (rows.clients ?? []).find((c) => c.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) => (rows.clients ?? []).filter((c) => where.id.in.includes(c.id))),
    },
  };
  const gw = new NotificationsGateway({} as any, { get: () => SECRET } as any, prisma);
  gw.server = server;
  /** Connects a socket the way socket.io would, with this token. */
  const connect = async (id: string, claims: object) => {
    const socket: any = {
      id,
      handshake: { auth: { token: sign(claims, SECRET, { expiresIn: "15m" }) }, headers: {} },
      data: undefined,
      rooms: [] as string[],
      join(room: string) {
        this.rooms.push(room);
      },
      disconnect: jest.fn(function (this: any) {
        disconnected.push(this.id);
        const i = sockets.indexOf(this);
        if (i >= 0) sockets.splice(i, 1);
      }),
    };
    await gw.handleConnection(socket);
    if (!socket.disconnect.mock.calls.length) sockets.push(socket);
    return socket;
  };
  return { gw, connect, disconnected, sockets, prisma };
}

describe("the notifications socket", () => {
  it("closes at once when the account's sessions end, on every device, and only that account's", async () => {
    const users = [
      { id: "u-ana", tenantId: "t1", isActive: true, tokenVersion: 0 },
      { id: "u-owner", tenantId: "t1", isActive: true, tokenVersion: 0 },
    ];
    const { gw, connect, disconnected } = gateway({ users });
    gw.onModuleInit();
    try {
      await connect("ana-laptop", { sub: "u-ana", role: "staff", tv: 0 });
      await connect("ana-phone", { sub: "u-ana", role: "staff", tv: 0 });
      await connect("owner", { sub: "u-owner", role: "owner", tv: 0 });

      sessionRevocations.revoke({ userId: "u-ana" });

      expect(disconnected.sort()).toEqual(["ana-laptop", "ana-phone"]);
    } finally {
      gw.onModuleDestroy();
    }
  });

  it("a client's too", async () => {
    const { gw, connect, disconnected } = gateway({
      clients: [{ id: "c1", tenantId: "t1", status: "active", tokenVersion: 0 }],
    });
    await connect("c1-socket", { sub: "c1", role: "client", tv: 0 });
    await gw.endSessions({ clientId: "c1" });
    expect(disconnected).toEqual(["c1-socket"]);
  });

  it("stops listening when the module goes", async () => {
    const { gw, connect, disconnected } = gateway({ users: [{ id: "u1", tenantId: "t1", isActive: true, tokenVersion: 0 }] });
    gw.onModuleInit();
    gw.onModuleDestroy();
    await connect("s1", { sub: "u1", role: "owner", tv: 0 });
    sessionRevocations.revoke({ userId: "u1" });
    expect(disconnected).toEqual([]);
  });

  it("the periodic re-check closes what ended without a word: deactivated, new session version, expired", async () => {
    const users = [
      { id: "u-ok", tenantId: "t1", isActive: true, tokenVersion: 2 },
      { id: "u-off", tenantId: "t1", isActive: true, tokenVersion: 0 },
      { id: "u-old", tenantId: "t1", isActive: true, tokenVersion: 0 },
    ];
    const clients = [{ id: "c-blocked", tenantId: "t1", status: "active", tokenVersion: 0 }];
    const { gw, connect, disconnected, prisma } = gateway({ users, clients });
    await connect("ok", { sub: "u-ok", role: "owner", tv: 2 });
    await connect("off", { sub: "u-off", role: "staff", tv: 0 });
    await connect("old", { sub: "u-old", role: "staff", tv: 0 });
    await connect("blocked", { sub: "c-blocked", role: "client", tv: 0 });
    // What happened meanwhile, by paths that did not say so:
    users[1].isActive = false; // deactivated
    users[2].tokenVersion = 1; // signed out everywhere
    clients[0].status = "blocked";

    const closed = await gw.recheckSockets();

    expect(closed).toBe(3);
    expect(disconnected.sort()).toEqual(["blocked", "off", "old"]);
    // One query per kind of account.
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.client.findMany).toHaveBeenCalledTimes(1);

    // And once its access token has expired, the socket goes too.
    expect(await gw.recheckSockets(Date.now() + 16 * 60_000)).toBe(1);
    expect(disconnected).toContain("ok");
  });
});

describe("who says the sessions ended", () => {
  let revoke: jest.SpyInstance;
  beforeEach(() => {
    revoke = jest.spyOn(sessionRevocations, "revoke");
  });
  afterEach(() => revoke.mockRestore());

  it("a team member deactivated or deleted (revokePanelLogin)", async () => {
    const db: any = { user: { updateMany: jest.fn(async () => ({ count: 1 })) } };
    await revokePanelLogin(db, "t1", "u-ana");
    expect(revoke).toHaveBeenCalledWith({ userId: "u-ana" });

    revoke.mockClear();
    db.user.updateMany = jest.fn(async () => ({ count: 0 })); // the owner's account, or already off
    await revokePanelLogin(db, "t1", "u-owner");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("their access removed, or their password changed by the owner", async () => {
    const pro = { id: "p1", tenantId: "t1", isActive: true, userId: "u-ana", user: { id: "u-ana", role: "staff" } };
    const db: any = {
      professional: { findFirst: jest.fn(async () => pro), findUnique: jest.fn(async () => pro) },
      user: { update: jest.fn(async () => ({})) },
    };
    const team = new AdminProfessionalsService(db);
    await team.revokePanelAccess("t1", "p1");
    expect(revoke).toHaveBeenCalledWith({ userId: "u-ana" });

    revoke.mockClear();
    await team.changePassword("t1", "p1", { newPassword: "otra-clave-2026" });
    expect(revoke).toHaveBeenCalledWith({ userId: "u-ana" });
  });

  it("PATCH /auth/password: the other sessions end, this one gets new tokens", async () => {
    const user = {
      id: "u-ana", email: "ana@salon.test", firstName: "Ana", lastName: "P", role: "staff", tenantId: "t1",
      isActive: true, passwordHash: bcrypt.hashSync("clave-actual-2026", 4), loginAttempts: 0, lockedUntil: null,
      tokenVersion: 3, professional: { id: "p-ana" },
    };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => user), update: jest.fn(async () => ({})) },
      client: { findUnique: jest.fn(async () => null) },
    };
    const sessions: any = { start: jest.fn(async () => ({ sid: "sid", jti: "jti" })), revoke: jest.fn() };
    const auth = new AuthService(prisma, { sign: () => "jwt", verify: jest.fn() } as any, {} as any, {} as any, {} as any, sessions, {} as any);
    const out = await auth.changeOwnPassword("u-ana", "clave-actual-2026", "nueva-clave-2026");
    expect(revoke).toHaveBeenCalledWith({ userId: "u-ana" });
    expect(out.tokens).toBeDefined();
  });

  it("a logout everywhere, for a user or a client", async () => {
    const prisma: any = { user: { update: jest.fn() }, client: { update: jest.fn() } };
    const auth = new AuthService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await auth.logoutEverywhere("u1");
    await auth.logoutEverywhere("c1", "client");
    expect(revoke.mock.calls).toEqual([[{ userId: "u1" }], [{ clientId: "c1" }]]);
  });
});

describe("a token from an ended session is not the salon's staff on public pages either", () => {
  it("compares its session version, as JwtStrategy does", async () => {
    const users: Record<string, any> = { "user-a": { isActive: true, tenantId: "tenant-a", tokenVersion: 1 } };
    const prisma: any = { user: { findUnique: async ({ where }: any) => users[where.id] ?? null } };
    const viewer = new PublicViewerService(new JwtService({}), { get: () => SECRET } as any, prisma);
    const req = (tv: number) => ({
      headers: { authorization: `Bearer ${sign({ sub: "user-a", role: "owner", tenantId: "tenant-a", tv }, SECRET)}` },
    });
    expect((await viewer.resolve(req(1))).staff).toBe(true);
    expect((await viewer.resolve(req(0))).staff).toBe(false);
  });
});
