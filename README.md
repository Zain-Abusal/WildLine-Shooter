# WILDLINE

A mobile-first open-world combat engine foundation built with TypeScript and native Canvas 2D. Explore a seeded wilderness, fight roaming enemies, harvest trees and rocks, and collect supply caches. No runtime framework or third-party game engine.

## Run locally

Use Node.js 22.12+ (or 24 LTS).

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. To test on an iPad on the same network, use the computer's LAN IP and Vite's port; the dev script binds to all interfaces.

```sh
npm test
npm run build
npm run preview
```

The start screen has two play choices: **Play Public** to find and enter an open match immediately, or **Party** for Create / Join onboarding. Empty online slots fill with bots and joining humans replace bots, keeping a 30-participant cap. **Party → Create → Bot Practice** starts offline play. If the online connection is unavailable, Public starts an explicitly labeled offline bot-practice match; it cannot receive remote humans until the player retries Public with a working connection. Join supports a friend’s code or public matchmaking. The large title appears only on the start screen. Once playing, the original tactical HUD remains visible. Escape opens its own pause menu; the Party menu is a separate screen.

Seed and generation controls are removed from the player UI. Every new game gets a fresh map. The internal generator still reproduces the same map from the same seed for tests. Gameplay URL parameters are discarded; only **?dev-mode=true** is retained to show Engine Live and PERF. FPS remains in a small corner in normal play.

## Controls

| Action                      | Keyboard / mouse           | iPad / touch                            |
| --------------------------- | -------------------------- | --------------------------------------- |
| Move                        | WASD or arrow keys         | Left joystick                           |
| Aim / camera lead           | Mouse                      | Right joystick                          |
| Attack                      | Hold left click            | Hold ATTACK                             |
| Collect cache / dropped gun | E                          | COLLECT (caches open automatically)     |
| Sprint (uses stamina)       | Hold Shift                 | Push the move stick to its edge         |
| Reload                      | R                          | RELOAD                                  |
| Fullscreen                  | Fullscreen button          | Fullscreen button / Home Screen web app |
| Equip carbine / axe   | 1 / 2 or HUD slots         | Tap HUD slots                           |
| Pause / resume              | Escape or top-right button | Top-right button                        |
| Leaderboard | Tab while playing or Leaderboard button | Leaderboard button |

Guns have finite magazines, reserves, reload times, and reach. Damage/cooldown are tuned so price tracks role (DPS: carbine 129, SMG 144, Vanguard 150, marksman 117, Sidekick 100, shotgun 90 with a 72-damage burst, longshot 76 at 95 damage). Carbine: 520 units, 24-round magazine; shotgun: 280 units, 6 rounds; sniper: 1800 units, 5 rounds; SMG: 340 units, 32 rounds; marksman: 1050 units, 12 rounds; Sidekick: 430 units, 14 rounds; Vanguard: 650 units, 20 rounds. Tracer lifetime subtracts the muzzle offset and clamps the final travel step to the range budget. Ammo and medkits are collected automatically on every device and touch devices auto-open nearby caches; guns always need E or COLLECT and never auto-equip. The axe damages nearby props and fighters in front of the player. Caches add supplies and restore 15 health. Death opens the restart screen. Solo gameplay pauses when the tab becomes hidden. An online room remains live while a player is in a menu or hidden tab. Health bars are drawn above the player, remote players, and solo fighters, after tree canopies.

## Host on Vercel (free Hobby plan)

Everything runs on Vercel: the static game plus one small Function, `api/signal.ts`. When a player hosts a match, **their browser runs the match authority** (rules, bots, damage, modes) in a Web Worker. Other players connect to that browser directly over WebRTC data channels, and gameplay traffic never passes through Vercel. The Function only stores short-lived "introductions": room listings, one connection offer and one answer per join, all expiring within a minute. That keeps usage well inside the free tier.

1. Import the Git repository into Vercel (project root). `vercel.json` sets Vite, `npm ci`, `npm run build`, output `dist`; `api/` is deployed automatically.
2. In the project, open **Storage**, create a free Redis database and connect it to the project. Either kind works: Vercel's Redis integration adds `REDIS_URL` (`redis://` / `rediss://`), and Upstash adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
3. Redeploy (environment variables apply to new deployments). `GET /api/signal` reports `{"status":"ok","store":"redis"}` (or `"redis-rest"`) when ready.

Without Redis, the deployed Function answers 503 and Public falls back to clearly labeled offline Bot Practice. Limits of browser hosting:

- If the host closes their tab, the match **migrates**: another player's browser (which receives a backup every second) takes over the same party code and everyone reconnects automatically with their kills, health and ammo intact. Only a host playing alone ends the match.
- Backgrounded mobile hosts (especially iOS Safari) may be suspended.
- Very strict networks (some schools and offices) can block direct browser-to-browser connections. Setting `VITE_TURN_URL`, `VITE_TURN_USERNAME` and `VITE_TURN_CREDENTIAL` adds a TURN relay, which is a service outside Vercel.
- Public STUN (Google) is used for address discovery.

Vercel Functions cannot host the authority themselves. Their WebSockets are not pinned to one instance per room, and connections close at the plan's maximum duration (5 minutes on Hobby).

Assets have content-hashed names and immutable caching. Google Fonts are optional and fall back to local fonts if unavailable. This project is hosting-ready; no deployment has been performed by this work.

## Multiplayer

`npm run dev` is all you need locally: the Vite dev server includes an in-memory `/api/signal`, so open two browser windows and use Party or Public. On an iPad, use the computer's LAN address. `npm run preview` (static only) has no signaling and shows the offline fallback.

Party onboarding starts with exactly two choices:

1. **Create a Party** → choose a callsign and Private (invite code) or Public (open to everyone), then create. The creator's browser hosts.
2. **Join a Party** → choose a callsign, enter a friend's code, or choose **Find Public Match** without a code.

**Public** looks for a listed public match, preferring your matchmaking bracket. Brackets come from games played on this device: Rookie 0–4, Regular 5–19, Veteran 20–59, Elite 60+. It never pairs brackets more than one apart, and it skips stale listings, trying up to three before hosting a new public match for you; bots fill it and others can join. Public bot difficulty follows the bracket (gentler for Rookies). Private rooms never appear in public search.

Matches have a hard cap of **30 total participants, humans plus bots**, in two sides of 15 (or everyone-for-themselves in Battle Royale / Free-for-All). Empty human slots are filled by bots; humans replace bot slots when joining. Bots and guests without a chosen callsign get player-style names (a guest's name is remembered on the device), so lobbies read like real matches. Friendly fire is disabled. Blue bars identify teammates, orange bars enemies. The HUD's **enemies left** counts only living opponents.

The authority validates movement speed (including sprint stamina), firing cooldowns, ammo, weapon masks, hit range, loot and results. Bots run at 10 Hz and state is broadcast at 20 Hz; bot AI processes only actors near humans, and far bots rotate inside the zone instead of dying unseen.

### Capacity (measured)

`npm run bench [matches] [seconds]` runs the real authority with full bot rosters. Measured on this machine:

| Matches in one process | Participants | CPU (one core) | Snapshot rate | Download per player |
| --- | --- | --- | --- | --- |
| 1 | 30 | ~2.6% | 20 Hz | ~65 KB/s |
| 10 | 300 | ~10% | 20 Hz | ~65 KB/s |
| 50 | 1,500 | ~30% | 20 Hz | ~64 KB/s |
| 100 | 3,000 | ~32% | ~12 Hz (degrading) | ~41 KB/s |

A match is capped at 30 participants by design. When a browser hosts, it uploads about 65 KB/s per other real player (about 0.6 MB/s with 10 humans), which is why matches cannot hold 100+ players in one room. Total players scale with the number of matches: each browser-hosted match runs on its host's device, and a dedicated server process handles about 50 matches. The limiting factor on free hosting is signaling usage (Redis commands and Function invocations): a public match costs roughly 75 Redis commands in total (it stops polling once closed to joins), each join about 12, and a private match about 1,500 per hour. The Upstash free tier (500K commands a month) therefore suits casual to moderate traffic; thousands of concurrent players need a paid Redis/Function plan.

### Optional dedicated server

`npm run multiplayer` runs the same authority behind a Node `ws` server, for hosts that are not tied to a player's tab. Set `VITE_MULTIPLAYER_URL=ws://localhost:8787` (or `wss://…` in production) to use it; `Dockerfile` and `render.yaml` package it for a container host. If you see "Port 8787 is already in use", a server is already running (`curl localhost:8787` shows its health), so stop it or choose another `PORT`. The server binds `0.0.0.0`, reads `PORT` (default 8787), permits 64 rooms / 512 connections, and has message-size/rate limits and heartbeat cleanup.

This is a playable multiplayer prototype, not a production competitive service: no accounts, private-room authentication, server-verified ranking (brackets are device-local), lag compensation, durable matches, reconnect tokens, or multi-instance room storage. Server movement validation does not yet enforce obstacle/slope physics; client prediction and authoritative corrections need further refinement before competitive release.

## iPad, progression, weapons and hiding

The canvas fills the available viewport. **Fullscreen** requests the native API where supported; iPad browsers that do not expose it show the **Share → Add to Home Screen** fallback. Home Screen metadata enables a standalone view. Touch controls suppress page gestures during play; joysticks release on pointer up/cancel, lost capture, final touch end/cancel, resize, blur and visibility changes. Browser/OS accessibility gestures may still override page behavior; physical iPad Safari validation remains pending.

**Shop** lists only items you have not unlocked; **Locker** lists only owned weapons/outfits and lets you change the starting loadout for your next match. Unlocked items move from the Shop to the Locker, and each tab's count matches what it lists. **Shop** uses a responsive illustrated item grid with local SVG previews for all seven firearms and seven outfits, All / Weapons / Outfits tabs, real item stats, ownership/equipped states and affordability checks. No remote image host or image-generation service is needed at runtime. **Shop** saves coins, XP, owned guns, equipped starting gun and outfit in localStorage under `wildline.profile.v1`. Eliminations award 25 coins/100 XP; wins award 100 coins/400 XP; elimination awards 10 coins/50 XP once. The shotgun costs 350 coins, sniper 700, SMG 450, marksman 550, Sidekick 200 and Vanguard 800. Azure/Ember outfits cost 150, Ghost/Orchid 225, Moss/Sunset 275. The shop has 14 illustrated items with category and rarity tags. Purchases apply to the next match; looted guns stay within their match. Progress survives reloads and new games on the same browser origin/device, not clearing site data, switching devices or private browsing sessions. Blocked/corrupt storage falls back safely and shows a notice. This local progression is editable by a device owner and is not a protected online economy or cloud account.

Private-party creation offers a **Bots on/off** toggle, **Relaxed / Standard / Veteran** bot difficulty, **Infinite ammo** and a firearm allow-list. Public rooms force bots on and standard difficulty. With bots off, a solo private player can explore while waiting; joining humans are balanced onto opposing teams, and the room does not end before an opponent enters. Axe is always available; at least one firearm is retained. Public matches enforce standard finite ammo and all seven firearms regardless of client options. The service validates equipped inventory, ammo, cooldown and maximum hit range. Eliminated actors drop their current firearm and remaining ammo; drops use capped storage. Ammo auto-picks up in range; collecting a gun equips it and starts a reload using available reserves.

Bushes can be walked through for concealment. Trees provide canopy cover and trunks block shots. Distant opponents in cover are hidden from normal rendering and bot targeting; proximity or firing reveals them. Teammates remain visible. This is gameplay concealment, not a network anti-wallhack guarantee. The storm is a fixed-center shrinking circle; moving storm centers and richer navigation remain future work.

The map starts as a compact 70-pixel preview. Tap **MAP** for a full match-area overview with the storm, yourself and living teammates; opponents are never plotted. Escape closes it. The expanded terrain image is generated once per seed/relief and cached. Ammo uses a larger high-contrast counter. Combat adds muzzle flashes, pooled impact sparks, hit markers and a damage border. **Sound On/Off** controls lightweight synthesized gunfire, hit, damage and elimination sounds; audio unlocks after a user gesture and falls back to silent play if unavailable.

## Game modes and spectating

Private party creation offers four modes (Public matchmaking always plays Team Battle):

| Mode | Sides | Respawn | Win |
| --- | --- | --- | --- |
| Team Battle | 15 v 15 | No | Last team standing in the storm |
| Battle Royale | Everyone for themselves | No | Last one standing in the storm |
| Free-for-All | Everyone for themselves | 4 s | First to 15 eliminations, or most after 5 minutes |
| Capture the Flag | 15 v 15, bases at x = ±1500 | 4 s at base | First to 3 captures, or most after 7 minutes |

In CTF, touch the enemy flag to carry it and return to your base while your own flag is home to score; a dropped flag stays where its carrier fell until an enemy picks it up or a defender returns it. Bots split into attackers and defenders, and carriers run home. Flags and bases appear on the map. Free-for-All/CTF kills award 10 coins (bots respawn, so farming is limited).

When you are eliminated in a private Team Battle or Battle Royale round, you spectate living players (teammates first) with ◀ / ▶, until the round ends; **RESULTS** leaves early. Public rounds still end on elimination. Offline Bot Practice supports Team Battle and solo Battle Royale (no allies); Free-for-All and CTF need an online party.

Bots wear a random outfit and carry a random allowed firearm each round, and every character visibly holds its actual gun. If you damaged an enemy in the last six seconds and a bot or the storm finishes it, the elimination is yours; allied bots also leave your current target alone unless it gets close to them.

## World, battle royale and loot

The world has **biomes**: forest, snowfields (snowy pines, frozen lakes) and desert (cacti, dunes, oases), driven by large-scale seeded noise. Nothing grows in water, sandy shores grow bushes instead of trees, props keep a minimum spacing so they never stand inside each other, and elevation contours are soft, biome-tinted lines. Players and bots never spawn in water or inside buildings, and the trail crosses lakes on wooden bridges. Supply caches are glowing **point gems** that add points (no healing; healing comes only from medkits). About one chunk in six has a **house** on dry ground (forest cabin, snow lodge or desert adobe) that blocks movement and bullets, with a cache on its doorstep. Rare ground **medkits** restore 25 health.

**Battle Royale** plays on a much larger island: the zone starts at radius 7000, holds for 60 seconds of looting and closes over 10 minutes. Spawns are scattered far apart. Everyone, including bots, starts with only the axe; Locker weapons do not carry over, only your outfit. About 30% of caches, plus every house's doorstep cache, are **chests**: each drops a rarity-weighted gun with ammo and, 45% of the time, a medkit. Unarmed bots head for chests. Offline practice enemies hold fire during the looting phase.

**Drops**: an eliminated fighter drops their gun and an ammo box as separate items (ammo capped at 60) and, 15% of the time, a medkit. Ammo and medkits are picked up automatically. **Guns are never picked up or equipped automatically**: press E or tap COLLECT, and taking a gun keeps your selected slot. Dropped guns show their actual illustration with a rarity glow (grey standard, blue rare, purple epic), and the weapon slot shows your gun's icon.

**Sprint**: hold Shift (or push the move stick to its edge) for 1.45× speed while stamina lasts; the blue bar under health is stamina and refills after a short pause.

**Balance**: weapon DPS rises with price/role (see the weapon list above). Bot hits use a capped share of their actual weapon's damage (max 25 online, 22 offline). Free-for-All/CTF respawns get a 2-second spawn shield that ends when you attack. Kills in respawn modes pay 10 coins.

**First time?** A short interactive tutorial (move, shoot, sprint, loot, zone, goal) appears on your first match; SKIP TUTORIAL closes it and the pause menu can replay it. Change your callsign any time from the start screen (**PLAYING AS … CHANGE**).

**Bots** pick a fighting distance that suits their gun (shotguns rush, marksmen hang back), strafe while shooting, take a moment to react to new targets, aim worse at range, go for medkits when hurt and get out of the storm. The **map** clusters houses into villages, turns high ground into rocky mountains and uses biome-specific rocks. The **shop** now has 12 outfits, 8 kill effects and 8 victory dances.

**Points** come from eliminations (10), point gems, harvesting and flag captures, and turn into coins at the end of the round (1 coin per 4 points, up to 60).

**Feedback**: shots kick the camera according to the weapon and leave glowing tracers, characters walk and flash when hit, and hits pop floating damage numbers. Your eliminations flash, burst into sparks in your equipped kill effect's colour, pop an "ELIMINATED" label and shake the camera slightly. Standing outside the zone pulses a storm-purple border around the screen. When a round ends, wins play your equipped victory dance full-screen, then a top-3 podium appears, then the results screen (SKIP or click to move on). The Shop sells **kill effects** (Gold Burst free, Frost Shatter, Ember Blaze, Neon Pulse, Void Rift) and **victory dances** (Victory Spin free, Hop Party, Axe Salute, Side Shuffle, Breakdown) alongside guns and outfits; equip them from the Locker. Audio uses a fixed Web Audio bank: every gun has its own layered sound (carbine crack, shotgun boom and pellet spread, longshot crack and rolling echo, tight SMG ticks, marksman crack and echo, Sidekick pop and slide click, Vanguard punch and metallic ring), other players' shots fading with distance and panned left/right, reload/pickup/chest/medkit/axe sounds, and ambient wind (stronger in snow and desert), forest birdsong and a storm rumble near the zone edge. The **leaderboard** is horizontal: your team on the left, the enemy team on the right, and the team score (eliminations, or captures in CTF) in the middle; solo modes show ranks with your placement.

## Credits and interface

A small **Credits** button at the bottom of the start screen opens `/about.html`, a creator-focused page for **Zain Abusal**. His bio, projects and links are adapted from [his portfolio](https://zainabusal.dev). There are no extra About sections in the game menus.

Public play uses a dedicated, cancellable Matchmaking view instead of opening Party. Menu backdrop clicks close/cancel the appropriate menu. Fullscreen is an icon in the header, separated from ammo and touch controls. The mouse uses a native crosshair at the pointer; the old fixed center marker is hidden. Touch aiming releases pointer aim when switching devices.

**Leaderboard** (button or Tab from the canvas) ranks the round's participants by eliminations. A bounded four-message kill feed shows killer, victim and weapon, highlighting your eliminations. Authoritative elimination events update kills/rewards immediately; serial deduplication and nondecreasing snapshot reconciliation prevent duplicate/lost credit. The feed expires entries after eight seconds. Offline allies/opponents use their fixed roster scores.

HUD, party, shop and result text use clearer contrast, larger labels and controls, opaque surfaces and a single-column mobile shop. The axe has a held-tool visual, visible swing and shared forward-arc hit detection for props and enemies online/offline.

Older snapshots missing optional fields retain safe defaults. An absent winner is an ongoing round, missing kills retain zero/current count, and invalid weapon IDs retain a valid weapon. Cancelled, timed-out and rejected joins clear pending state so retries remain available.

## Architecture

| File             | Responsibility                                                                          |
| ---------------- | --------------------------------------------------------------------------------------- |
| src/audio.ts | Eight reusable Web Audio voices, gesture unlock and mute |
| src/main.ts      | Canvas bootstrap and loop lifecycle                                                     |
| src/engine.ts    | Fixed-step loop, camera, combat, culling, vector rendering and telemetry                |
| src/combat.ts    | Shared weapon stats, ammo/reach rules, storm timing                                     |
| src/profile.ts   | Validated device-local progress and shop purchases                                      |
| src/network.ts   | Fixed remote-player pool, binary state transport, room connection lifecycle             |
| server/index.ts  | WebSocket rooms, snapshots, combat authority, shared edits and round results            |
| src/landscape.ts | Fixed terrain raster caches and prerendered prop sprites                                |
| src/world.ts     | FNV-style text hash, stateless 2D simplex noise, chunk generation, bounded edit journal |
| src/entities.ts  | Player momentum and structure-of-arrays object pools                                    |
| src/input.ts     | Pointer Events, keyboard, dual touch sticks, cancellation and focus reset               |
| src/style.css    | Responsive tactical HUD and touch controls                                              |

One requestAnimationFrame drives a 60 Hz fixed-step simulation and a single render stage. Catch-up is capped at five steps. DPR is capped at 2; camera scaling bounds the logical viewport to at most 1800 × 1200 world units. Terrain uses 512-unit chunks with 64 height samples and 24 deterministic prop/spawn vectors per chunk. A fixed 100-slot chunk pool comfortably covers the maximum padded view, recycling storage rather than growing it.

A preallocated 128 × 128 terrain tile per chunk slot uses approximately 6.25 MiB of pixel storage, plus three tree sprites and one rock sprite. These caches replace repeated terrain and canopy path drawing without growing as the player travels.

Pools preallocate 160 projectiles, 384 particles, and 26 enemy fighters, three solo companions, and 30 remote participant slots, and bounded 96-slot loot pools. Saturation skips a spawn; arrays never grow. The simulation processes only resident chunks in the current viewport plus one chunk of padding, while rendering culls to the visible area. Distant chunks surrender their slot, and their backing arrays are reused. An 8192-entry bounded edit journal retains destruction, collection, across chunk eviction. Offline fighters retain fixed roster slots for the round.

World layout and drops are reproducible for the same seed and coordinates, independent of travel order. Player input and combat outcomes are not a deterministic network replay implementation.

## Performance and limits

The simulation uses preallocated numeric arrays and no per-tick entity objects. This is an allocation-conscious foundation, not a certified zero-GC browser runtime: browser rendering internals, input events, notifications and throttled DOM telemetry and WebSocket receive-message decoding may allocate. FPS and frame time show observed animation cadence, not CPU-only frame cost. Entities counts the player plus live pooled fighters, particles, and projectiles; static props are excluded.

Streaming scans run only when padded chunk bounds change. Static menus skip repeated scene rendering, hidden diagnostics skip graph drawing, and concealment is tested once per local enemy update. Fixed pools remain bounded. These are implementation reductions in work, not measured physical-device FPS improvements.

Current presentation is layered 2.5D Canvas art. Height samples drive shaded elevation contours and water movement (145 units/s in water, 235 on land); aiming and slopes do not reduce land speed; there is no true 3D renderer or building system yet. World edits are memory-only and the oldest entry expires when the journal fills. Starting a new round clears the journal and all round state; device-local progression is retained. Solo match fighters retain their fixed roster slots when offscreen and only run local AI inside the padded view; defeated fighters never respawn during the round. See PROJECT_PLAN.md for the next milestones.

## Verification

Verified on 2026-10-17 (latest pass): `npm test` 42/42 (including authority, modes, battle royale loot, sprint validation, signaling, matchmaking brackets, host migration, cosmetics and terrain spacing), `npm run build`, `npm run test:browser`, `npm run test:scenarios`, `npm run test:production` and `npm run test:p2p` (two separate Chromium contexts hosting/joining over WebRTC through the dev signaling endpoint, including a stale public listing and a real host-tab-close migration with a third player) all pass. A bounding-box audit of desktop, laptop, iPad landscape/portrait and phone portrait/landscape reports no HUD overlaps. Earlier coverage: restored HUD without intro title, hidden seed controls, fresh seeded rounds, clean URL and ignored URL parameters, deterministic internal generation, diagnostics toggle, movement, firing, equipment, pause/resume, high-DPI sizing, simultaneous three-touch iPad-style controls, touch release, guided party setup, private/public visibility, bot fill, two-browser party creation/join/leave, separate Start / Escape / Party screens, gesture suppression, loss/victory screens, shop/locker, mobile layout, dev-mode gating, expanded team map and audio mute. No browser runtime errors were observed. Real deployment on Vercel with Redis, and physical iPad/low-end laptop runs, have not been performed.

The scenario suite exercises the reported incomplete-snapshot Public regression, private solo entry/rematch, fresh map state, invalid-code retries, actual local axe damage, 30-slot leaderboard/backdrop behavior, confirmed kill/reward/feed updates, native cursor, private bot controls, distributed spawns, 14 tagged shop items and creator Credits. The production check also asserts that mobile header buttons do not overlap.

Core tests cover seed reproducibility, simplex continuity, bounded streaming and storage reuse, edit restoration, pool saturation/recycling, and momentum limits.

```sh
npm run test:browser
npm run test:scenarios
npm run build
npm run test:production
npm run test:p2p
```

Browser smoke tests require Playwright Chromium (`npx playwright install chromium`), or set `CHROME_PATH` to a local Chrome executable. The browser suite starts and closes its own local Vite and WebSocket servers. The production check previews dist without a realtime endpoint and verifies the labeled bot-practice fallback, real touch attack, fixed eight-voice audio bank, mute, map expansion and non-overlapping ammo/fullscreen layout. Physical iPad Safari performance and sustained heap/GC measurements remain required before performance certification.

Shared implementation rules live in AGENTS.md.

Generation includes seed-dependent terrain offsets, paths, and camp placement. Elevation is retained internally for terrain and water movement. Fighters have three seeded archetypes: fast lightly armored scouts (45 HP), standard fighters (60 HP), and slower heavy fighters (100 HP), with different colors and contact damage. The same internal seed/settings reproduce the same world; normal new games select a fresh seed.
