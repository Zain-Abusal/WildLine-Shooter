// Authority load benchmark: CPU per match and snapshot bandwidth. Run: npx tsx tests/bench.mts
import { createAuthority, type Conn } from "../src/authority";
const rooms = Number(process.argv[2] || 1),
  seconds = Number(process.argv[3] || 6);
const authority = createAuthority();
let bytes = 0,
  snapshots = 0,
  largest = 0;
const conn = (): Conn => ({
  open: true,
  buffered: 0,
  send(d) {
    bytes += d.length;
    if (d.startsWith('{"t":"state"')) {
      snapshots++;
      largest = Math.max(largest, d.length);
    }
  },
  close() {},
  terminate() {},
});
const packet = (t: number) => new Uint8Array(new Float64Array([t, 0, 0, 0]).buffer);
for (let r = 0; r < rooms; r++) {
  const h = authority.connect(conn());
  h.message(JSON.stringify({ t: "join", room: "BENCH" + r, name: "P", create: true, mode: r % 2 ? "br" : "teams" }), false);
  h.message(packet(5), true);
}
// Measure event-loop busy time while the authority's 10 Hz / 20 Hz timers run.
const start = performance.now();
let busy = 0;
const realNow = performance.now.bind(performance);
const probe = setInterval(() => {}, 1000);
const { monitorEventLoopDelay, performance: perf } = await import("node:perf_hooks");
const elu0 = perf.eventLoopUtilization();
void monitorEventLoopDelay;
await new Promise((r) => setTimeout(r, seconds * 1000));
const elu = perf.eventLoopUtilization(elu0);
busy = elu.utilization;
clearInterval(probe);
authority.close();
const elapsed = (realNow() - start) / 1000;
console.log(
  JSON.stringify({
    rooms,
    participants: rooms * 30,
    cpuPercentOfOneCore: +(busy * 100).toFixed(1),
    snapshotsPerSecondPerClient: +(snapshots / rooms / elapsed).toFixed(1),
    largestSnapshotBytes: largest,
    downloadKBpsPerClient: +(bytes / rooms / elapsed / 1024).toFixed(1),
  }),
);
