# WILDLINE project plan

Updated: 2026-10-17. Target: iPad Safari and lower-end laptop browsers.

## Milestone 1 — playable engine foundation

- [x] Full-screen high-DPI Canvas 2D with capped DPR and responsive tactical HUD.
- [x] Isolated fixed-step update and render inside one requestAnimationFrame loop.
- [x] Text-seed hashing and stateless 2D simplex terrain generation.
- [x] Deterministic height arrays, destructible prop vectors, supply drops, and fighter spawn anchors.
- [x] Infinite coordinate-addressed chunk streaming through fixed reusable slots.
- [x] Viewport plus one-chunk simulation padding; tighter draw culling.
- [x] Fixed-capacity projectile, particle, and fighter pools with safe saturation.
- [x] Momentum-controlled player, health, collision, aiming, ranged attack, and melee axe harvesting.
- [x] Responsive dual-stick touch controls and attack/collect buttons; WASD and mouse.
- [x] Original tactical HUD restored; only large intro text removed. Generation controls removed from player UI; deterministic generator retained internally.
- [x] Gameplay query settings ignored; diagnostics-only dev-mode flag allowed; reproducible in-app generation; seed-dependent paths/camps, three fighter archetypes, elevation contours and water slowdown and direction-independent land speed.
- [x] Pause, resume, death/restart, seed regeneration, minimap, and throttled telemetry.
- [x] Preallocated terrain raster caches and tree/rock sprites to reduce draw overhead.
- [x] Health bars above all characters, rendered after canopies.
- [x] Vercel static build configuration and project documentation.
- [ ] Physical iPad Safari and low-end laptop acceptance run.
- [ ] Heap/GC allocation trace and 10-minute sustained traversal on target hardware.

## Milestone 2 — performance certification

1. Capture physical-device FPS distributions and main-thread frame timings after warm-up. Target 60 FPS where feasible; provide 30 FPS quality fallback if required.
2. Profile allocation timelines during movement, continuous fire, combat, and boundary crossing. Confirm application simulation has no per-tick allocations. Separate DOM telemetry, browser drawing, and event allocation from simulation.
3. Run a 10-minute diagonal traversal and saturation test. Confirm heap settles after warm-up and fixed pools remain fixed.
4. Test all iPad orientations, Split View, safe areas, simultaneous three-finger controls, cancellation, focus loss, hidden/resume, and Safari address-bar resize.
5. Optimize measured bottlenecks before adding complexity: spatial lookup for fighter anchors, dirty-boundary chunk sync, cache resolution and broad-phase collision only if justified.

## Milestone 3 — richer encounters

- Deterministic loot tables, additional weapons, enemy behavior and spatial broad phase.
- Player terrain-height interaction, elevation-aware occlusion and stronger depth ordering.
- Richer moving storm centers, match objectives, audio toggles and accessibility options.
- Persistent world edits via bounded IndexedDB storage with documented eviction semantics.

## Milestone 4 — multiplayer prototype

- [x] 30-participant party creation/join by code, callsigns, shared seed/settings, room isolation; no player-facing server fields.
- [x] Start screen before play; Escape and Party screens remain separate. Lobby party members are immune until entering the game.
- [x] Two-choice Create/Join onboarding, guided callsign/settings steps, Back navigation, private/public visibility.
- [x] Public matchmaking that excludes private rooms and fills the busiest available public match.
- [x] Two teams of 15; humans replace fixed bot slots; friendly fire is disabled.
- [x] Server-controlled enemy and teammate bots with pursuit, patrol, firing, collision, final elimination, team bars, and BOT labels.
- [x] Three offline companion bots; solo hostile pool limited to 26 plus player for a 30-character maximum.
- [x] Pooled remote-player interpolation and binary outgoing state packets.
- [x] Server-controlled PvP damage, health, firing cooldowns, movement speed limit and final elimination.
- [x] Shared destructible props and caches, bounded edit journal, late-join restoration.
- [x] Heartbeats, payload/rate limits, disconnect cleanup and solo fallback.
- [x] Two-client server integration tests for seed authority, room isolation, damage, fire spam, movement rejection, edits and eliminated-player respawn rejection.
- [x] Spread-out spawns, finite-reach weapons, magazines/reserves/reloads, private ammo and weapon rules.
- [x] Elimination gun/ammo drops with automatic ammo pickup; iPad auto-collection of nearby caches/guns.
- [x] Fixed-center shrinking storm, damage escalation, players-left and kills counters, victory/loss screens.
- [x] Bush/tree concealment and bot-targeting rules with firing/proximity reveal.
- [x] Direct Play Public action from the start screen, in addition to guided party onboarding.
- [x] Responsive illustrated shop with fourteen local item previews, category tabs, actual stats, ownership/equipped and affordability states.
- [x] Device-saved coin/XP progression, cosmetic/weapon shop, persistence and corrupt/blocked-storage fallback.
- [x] Touch release/cancellation reset, gameplay gesture suppression, fullscreen control and iPad Home Screen fallback.
- [ ] Real deployment (Vercel + Redis for browser-hosted play, or the optional Dockerfile server) and physical iPad internet multiplayer validation.
- [ ] Account/private-room access control, lag compensation, obstacle-aware movement authority, robust reconciliation and reconnect tokens.
- [ ] Advanced AI navigation, match persistence and multi-instance storage.

The client remains Vercel-hostable. The current realtime process requires a separately managed persistent Node host; vercel.json deploys the client only. Online rooms are team combat with shared server bots; offline NPC simulation is disabled in those rooms.

## Acceptance and verification record

Passed on 2026-10-17: npm test (25/25), npm run build (TypeScript + Vite), and npm run test:browser (Chromium, desktop and emulated iPad multi-touch). Restored HUD, custom generation, clean URL and ignored query parameters, diagnostics toggling, and two-choice guided onboarding, public matchmaking, 30-slot bot fill, solo companion bots, two-browser party create/join/leave and distinct Start / Escape / Party screens plus device persistence, purchases, auto-loot, gestures and result screens are covered. Details are recorded in README.md. No physical-device benchmark has been performed; the live HUD reports observed rendering cadence rather than a performance guarantee.

## Known design tradeoffs

- Canvas 2D with layered vector art provides 2.5D presentation, not true 3D geometry.
- Terrain heights drive contour shading and water slowdown and direction-independent land speed; true vertical projection, elevation-aware projectiles, and terrain occlusion remain deferred.
- Destroyed/collected objects persist across chunk recycling only within an 8192-entry FIFO edit journal. Reset/reload clears edits.
- Unloading an injured fighter resets its combat health and position on re-entry; defeated fighter anchors remain suppressed by the edit journal.
- An infinite coordinate space is represented with JavaScript numbers; extreme distances eventually lose precision. Origin rebasing is deferred.

## Remaining gameplay limits

Native iPad fullscreen/gesture behavior still needs physical Safari testing. Progress is local to an origin/device and can be edited or cleared by its owner. Online accounts/cloud saves and a protected economy are not implemented. Solo matches use the fixed expedition roster; online team rounds use server authority. Loot is capped and oldest server drops expire at capacity. Storm circles currently close around the origin rather than choosing new centers.

## Gameplay and visibility update — 2026-10-17

- [x] Two main play actions: Public and Party, with clearly labeled offline practice fallback.
- [x] Existing online bot fill/replacement retained under the 30-combatant limit.
- [x] Allied patrol routes replace following; local opponents use ranged shots.
- [x] Direction-independent land speed and slower water movement.
- [x] Seven firearms and seven outfits with local previews; owned-item Locker.
- [x] Larger ammo readout, muzzle flash, damage border, confirmed hit feedback, fixed-voice audio and mute.
- [x] Compact expandable map with self/living teammates only.
- [x] Diagnostics gated by ?dev-mode=true; corner FPS retained.
- [x] Skip unchanged chunk-bound scans, cache expanded-map terrain, reuse audio nodes, skip static scene redraws and hidden graph work.
- [ ] Physical iPad audio/fullscreen and low-end laptop performance measurements.

Unit coverage includes new item persistence, equal-speed diagonal movement/water speed and streaming-cache invalidation. Chromium browser acceptance passes for the new controls, mobile action visibility, ammo bounds, locker, category tabs, dev-mode gating, public bot fill, expanded team map and audio mute. The production static-build check also exercises offline bot fallback, real touch firing, reused audio voices and non-overlapping ammo/fullscreen. Physical-device performance remains unmeasured.

## Round lifecycle, compatibility and clarity

- [x] Only explicit winner or confirmed elimination ends a round; missing kills/weapon fields have safe defaults.
- [x] New games choose a new seed and reset map/loot/storm/combat state while retaining device progress.
- [x] Private host rematches keep party members, code and rules; host transfer and live-team-round protections.
- [x] All seven guns accepted by authority; private bots always obey the actual allowed weapon mask.
- [x] Axe naming, held-tool visual, shared forward arc and prop/enemy hit feedback.
- [x] Pending join cleanup, invalid-code retries, cancellation and incomplete-snapshot regressions.
- [x] Larger, higher-contrast UI and single-column mobile shop.
- [x] Creator-focused static page crediting Zain Abusal from zainabusal.dev, reached only by a small bottom Credits button.
- [ ] Physical iPad accessibility/readability and touch axe acceptance.

No finite test suite covers every possible scenario. Automated coverage focuses on reproducible defects, match transitions and recoverable connection failures.

## Latest play/UX refinement

- [x] Small bottom Credits button only; creator-focused Zain Abusal page.
- [x] Native mouse crosshair instead of fixed center reticle; touch/mouse aim handover.
- [x] Distributed spawn sectors/local radial roster, varied patrol radii and separation.
- [x] Seven firearms/seven outfits, 14 local previews, category/rarity tags and device ownership.
- [x] Fixed 30-row leaderboard; four-message expiring elimination feed with authority/deduplication.
- [x] Private bots toggle/difficulty, public enforced defaults and no-bot solo waiting logic.
- [x] Dedicated Public matchmaking/cancel, menu backdrop dismissal and header fullscreen control.
- [ ] Physical iPad/low-end laptop acceptance remains required.

## Modes, balance and device polish — 2026-10-17

- [x] Private game modes: Team Battle, Battle Royale, Free-for-All (respawn) and Capture the Flag (respawn, bases, carriers, captures); public forced to Team Battle.
- [x] Private-round spectating of living players with prev/next and early results.
- [x] Random per-round bot outfits and firearms (allowed mask respected); held-gun silhouettes per weapon.
- [x] Assist kill credit (6 s) for bot/storm finishes; allied bots stop stealing the player's target.
- [x] Shop shows unowned items only, Locker owned items only, accurate per-tab counts.
- [x] Larger match area (storm 3000, 6-minute cycle) with wider spawns/patrols; off-screen offline bots rotate inward.
- [x] Weapon DPS rebalance; reduced respawn-mode kill coins.
- [x] HUD overlap fixes for desktop, iPad landscape/portrait, phone portrait/landscape (automated bounding-box audit), shop header bleed fix.
- [x] Dockerfile + Render Blueprint for the realtime server (image build and health check verified locally; not deployed).
- [ ] Physical-device play of the new modes and spectating; bot CTF tactics beyond attack/defend split.

Verified: npm test (32/32), npm run build, npm run test:browser, npm run test:scenarios (includes CTF HUD, FFA respawn and spectating) and npm run test:production all pass.

## All-Vercel hosting, battle royale overhaul and polish — 2026-10-17

- [x] Transport-neutral authority (src/authority.ts) shared by the optional Node server and a browser Worker host.
- [x] Browser-hosted P2P multiplayer over WebRTC with Vercel Function signaling (api/signal.ts + Marketplace Redis); dev-server memory signaling; stale-listing retry and host unregister on tab close.
- [x] Battle royale: 7000-radius island, 60 s looting hold, scattered spawns, axe-only start (outfits only from Locker), chests with rarity-weighted guns/ammo/medkits, chest-seeking unarmed bots.
- [x] Biomes (forest/snow/desert) with palettes and props; surface rules (no props in water, shore bushes); biome houses that block movement/shots; rare ground medkits.
- [x] Separate gun/ammo drops, 15% medkit drop, fixed-point medkits (+25), no automatic gun pickup/equip.
- [x] Sprint with stamina (client + authority validation); enemies-only players-left counter.
- [x] Device games-played brackets for public matchmaking and bracket-scaled public bot difficulty.
- [x] Player-style callsigns for bots and guests; horizontal team leaderboard with centre score.
- [x] Gun icons in the weapon slot and on dropped loot; kill shockwave effect; victory dance on wins.
- [x] Fixed Web Audio bank with per-weapon shots, spatial falloff/pan, pickup/chest/heal/reload sounds and biome ambient + storm rumble.
- [x] Balance: capped bot hit damage, capped ammo drops, respawn spawn shield, respawn-mode kill coins.
- [ ] Real Vercel deployment with Redis and cross-network (NAT/TURN) multiplayer validation.
- [ ] Host migration when the hosting player leaves; physical iPad/low-end laptop acceptance.

Verified: npm test (39/39), npm run build, test:browser, test:scenarios, test:production and test:p2p all pass; HUD overlap audit clean at six viewports. Browser-hosted matches trust the host's device (no anti-cheat beyond the authority's own validation).
