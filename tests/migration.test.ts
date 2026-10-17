import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthority, type Conn } from "../src/authority";

function fakeConn(local = false) {
  const sent: any[] = [];
  const conn: Conn & { sent: any[] } = {
    open: true,
    buffered: 0,
    local,
    sent,
    send: (d) => sent.push(JSON.parse(d)),
    close() {
      (this as { open: boolean }).open = false;
    },
    terminate() {},
  };
  return conn;
}
const packet = (t: number, a = 0, b = 0, c = 0) =>
  new Uint8Array(new Float64Array([t, a, b, c]).buffer);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("host migration: a successor restores the room and players reclaim their slots", async () => {
  const a = createAuthority({ backups: true });
  const b = createAuthority({ backups: true });
  try {
    a.setBackupToken("secret-token");
    const hostConn = fakeConn(true),
      guestConn = fakeConn();
    const host = a.connect(hostConn),
      guest = a.connect(guestConn);
    host.message(
      JSON.stringify({ t: "join", room: "MIG1", name: "Host", create: true, mode: "ctf" }),
      false,
    );
    guest.message(JSON.stringify({ t: "join", room: "MIG1", name: "Guest", create: false }), false);
    host.message(packet(5), true);
    guest.message(packet(5), true);
    const welcome = guestConn.sent.find((m) => m.t === "welcome");
    assert.ok(welcome.resume, "players receive a resume token");
    const room = a.rooms.get("MIG1")!;
    const guestPlayer = room.players.get(welcome.id)!;
    guestPlayer.kills = 4;
    guestPlayer.health = 61;
    room.captures[guestPlayer.team] = 2;
    await delay(1100);
    const backup = guestConn.sent.filter((m) => m.t === "backup").pop();
    assert.ok(backup, "the remote player (successor) receives backups");
    assert.equal(hostConn.sent.filter((m) => m.t === "backup").length, 0, "never the local host");
    assert.equal(backup.state.token, "secret-token");
    assert.ok(!JSON.stringify(backup.state).includes('"ws"'));

    // The guest's browser takes over: restore, then reclaim through its own loopback.
    b.restore(backup.state, [{ x: 0, y: 0, i: 3, hp: 0 }]);
    const restored = b.rooms.get("MIG1")!;
    assert.equal(restored.mode, "ctf");
    assert.equal(restored.players.size, 0, "humans wait to reclaim their slot");
    assert.equal(restored.edits.size, 1);
    const newLocal = fakeConn(true);
    const reclaimed = b.connect(newLocal);
    reclaimed.message(
      JSON.stringify({ t: "join", room: "MIG1", name: "Guest", resume: welcome.resume }),
      false,
    );
    const resumedWelcome = newLocal.sent.find((m) => m.t === "welcome");
    assert.equal(resumedWelcome.resumed, true);
    assert.equal(resumedWelcome.id, welcome.id, "same player identity");
    const me = restored.players.get(welcome.id)!;
    assert.equal(me.kills, 4);
    assert.equal(me.health, 61);
    assert.equal(me.ready, true);
    assert.equal(restored.captures[me.team], 2);
    assert.equal(restored.hostId, me.id, "host role transfers to the first player back");
    // A stolen or stale token cannot claim a slot.
    const thief = fakeConn();
    b.connect(thief).message(
      JSON.stringify({ t: "join", room: "MIG1", name: "X", resume: "nope" }),
      false,
    );
    assert.equal(thief.sent[0].t, "error");
    // The restored room keeps running and broadcasts state.
    await delay(120);
    assert.ok(newLocal.sent.some((m) => m.t === "state"));
  } finally {
    a.close();
    b.close();
  }
});
