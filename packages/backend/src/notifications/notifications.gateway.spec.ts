import { sign } from "jsonwebtoken";
import { NotificationsGateway } from "./notifications.gateway";

/**
 * The gateway used to trust tenantId, userId and clientId sent in the
 * handshake, with no token: anyone who knew a salon's id (it is public)
 * received its notifications. The identity now comes from the access token.
 */
const SECRET = "test-secret-that-is-long-enough-for-hs256";

function gateway(rows: { user?: any; client?: any } = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn(async () => rows.user ?? null) },
    client: { findUnique: jest.fn(async () => rows.client ?? null) },
  };
  const config: any = { get: () => SECRET };
  return new NotificationsGateway({} as any, config, prisma);
}

function socket(auth: any = {}, headers: any = {}) {
  const rooms: string[] = [];
  return {
    id: "s1",
    handshake: { auth, headers },
    data: undefined as any,
    rooms,
    join: (room: string) => rooms.push(room),
    disconnect: jest.fn(),
  };
}

describe("NotificationsGateway", () => {
  it("refuses a socket without a token, whatever tenant it names", async () => {
    const s = socket({ tenantId: "t1", userId: "u1" });
    await gateway({ user: { id: "u1", tenantId: "t1", isActive: true, tokenVersion: 0 } }).handleConnection(s as any);
    expect(s.disconnect).toHaveBeenCalled();
    expect(s.rooms).toEqual([]);
  });

  it("refuses a token signed with another key", async () => {
    const token = sign({ sub: "u1", role: "owner" }, "another-secret-of-sufficient-length");
    const s = socket({ token });
    await gateway({ user: { id: "u1", tenantId: "t1", isActive: true, tokenVersion: 0 } }).handleConnection(s as any);
    expect(s.disconnect).toHaveBeenCalled();
  });

  it("takes the rooms from the token, not from what the socket claims", async () => {
    const token = sign({ sub: "u1", role: "owner", tenantId: "t1" }, SECRET);
    const s = socket({ token, tenantId: "someone-else", userId: "u9" });
    await gateway({ user: { id: "u1", tenantId: "t1", isActive: true, tokenVersion: 0 } }).handleConnection(s as any);
    expect(s.disconnect).not.toHaveBeenCalled();
    expect(s.rooms.sort()).toEqual(["tenant:t1", "user:u1"]);
  });

  it("accepts the token in the Authorization header too", async () => {
    const token = sign({ sub: "u1", role: "staff" }, SECRET);
    const s = socket({}, { authorization: `Bearer ${token}` });
    await gateway({ user: { id: "u1", tenantId: "t1", isActive: true, tokenVersion: 0 } }).handleConnection(s as any);
    expect(s.rooms).toContain("user:u1");
  });

  it("puts a client in their own room only, never the salon's", async () => {
    const token = sign({ sub: "c1", role: "client" }, SECRET);
    const s = socket({ token });
    await gateway({ client: { id: "c1", tenantId: "t1", status: "active", tokenVersion: 0 } }).handleConnection(s as any);
    expect(s.rooms).toEqual(["client:c1"]);
  });

  it("refuses a deactivated user and a blocked client", async () => {
    const userToken = sign({ sub: "u1", role: "owner" }, SECRET);
    const u = socket({ token: userToken });
    await gateway({ user: { id: "u1", tenantId: "t1", isActive: false } }).handleConnection(u as any);
    expect(u.disconnect).toHaveBeenCalled();

    const clientToken = sign({ sub: "c1", role: "client" }, SECRET);
    const c = socket({ token: clientToken });
    await gateway({ client: { id: "c1", tenantId: "t1", status: "blocked", tokenVersion: 0 } }).handleConnection(c as any);
    expect(c.disconnect).toHaveBeenCalled();
  });
});
