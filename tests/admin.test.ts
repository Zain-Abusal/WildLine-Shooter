import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthority, type Conn } from "../src/authority";

const conn = (local = false): Conn & { sent: any[] } => {
  const sent: any[] = [];
  return {
    open: true,
    buffered: 0,
    local,
    sent,
    send: (d) => sent.push(JSON.parse(d)),
    close() {},
    terminate() {},
  };
};
const packet = (t: number, a = 0, b = 0, c = 0) =>
  new Uint8Array(new Float64Array([t, a, b, c]).buffer);
const join = (a: ReturnType<typeof createAuthority>, c: Conn, room: string, extra = {}) => {
  const h = a.connect(c);
  h.message(JSON.stringify({ t: "join", room, name: "P", ...extra }), false);
  h.message(packet(5), true);
  return h;
};

test("admin tools: only the hosting browser, never against real players in public", () => {
  const a = createAuthority();
  try {
    const hostConn = conn(true),
      host = join(a, hostConn, "ADM1", { create: true });
    const room = a.rooms.get("ADM1")!,
      me = [...room.players.values()][0];
    host.message(JSON.stringify({ t: "admin", op: "tp", x: 4321, y: -1234 }), false);
    assert.deepEqual([me.x, me.y], [4321, -1234], "host can teleport itself");
    host.message(JSON.stringify({ t: "admin", op: "flags", god: true, ammo: true }), false);
    assert.equal(me.admin?.god, true);

    // A remote (non-local) player cannot use the admin channel.
    const guestConn = conn(false),
      guest = join(a, guestConn, "ADM1");
    const them = [...room.players.values()].find((p) => p !== me)!;
    const before = [them.x, them.y];
    guest.message(JSON.stringify({ t: "admin", op: "tp", x: 1, y: 1 }), false);
    assert.deepEqual([them.x, them.y], before);
    assert.equal(them.admin, undefined);

    // Invulnerable: the guest's shots do no damage to the host.
    them.team = 1 - me.team;
    me.x = 0;
    me.y = 0;
    them.x = 60;
    them.y = 0;
    them.lastShot = 0;
    guest.message(packet(2, Math.PI, them.weapon), true);
    assert.equal(me.health, 100);

    // Public match with another real player: admin is refused.
    const pubHost = conn(true),
      ph = join(a, pubHost, "ADMPUB", { create: true, public: true });
    join(a, conn(false), "ADMPUB", { create: false });
    const pub = a.rooms.get("ADMPUB")!,
      hostPlayer = [...pub.players.values()][0];
    const spot = [hostPlayer.x, hostPlayer.y];
    ph.message(JSON.stringify({ t: "admin", op: "tp", x: 9999, y: 9999 }), false);
    assert.deepEqual([hostPlayer.x, hostPlayer.y], spot, "no admin against real players in public");
  } finally {
    a.close();
  }
});
