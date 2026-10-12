# GAME DESIGN SPEC: "Plague Cauldron" (re-implementation of the gameplay shown in `ad.mp4`)

Source: `ad.mp4` (608x1080, 30 fps), gameplay 0.20-52.63 s. Synthesised from eight analyst reports (`seg_A..E.md`, `layout.md`, `art.md`, `dynamics.md`) plus my own frame checks (crops in `work/spec/`).

Tags used everywhere:

- **[SEEN t]** = directly visible in the footage at video time t (seconds).
- **(inferred)** = deduced from what is visible; not directly shown.
- **[EXTENDED]** = not in the footage; designed here to make a complete game.

Ignored ad overlays: white Japanese subtitles (y 925-975), gold logo bottom-right, the 0.00-0.17 s key-art freeze, the blue wipe from 52.73 s, the end card.

---

## 0. Conventions and resolved contradictions

### 0.1 Units and scale

- Lengths in **metres**, times in **seconds**, angles in degrees. World axes (three.js style): **+x = east, +y = up, +z = south**. Origin = ground point under the centre of the cauldron.
- **Scale anchor: the dashed ring under the doctor has diameter 1.6 m.** All analyst lengths were normalised through that ring.
- **Doctor = 1.9 m** from feet to the top of the hat crown (2.15 m with the feather). Measured by me: 10.2 s ring 86x52 px, crown-to-feet 82 px; 23.4 s ring 100x64 px, crown-to-feet 91 px; with pitch 40 deg this gives 1.19-1.25 ring diameters.
- The analysts' private units convert as: seg_A "H" = 2.57 m, dynamics "H" = 2.08 m, seg_B/C/E "dh/H" = about 2.0 m, seg_D "ring-dia" = 1.6 m, layout already in these metres, art "H" = about 1.9-2.2 m.
- At the usual zoom 1 m on the ground is 52-66 px across the screen; a ground circle projects as an ellipse with height/width 0.64.
- Screen directions map to the ground as: **screen-up = F = (0.64, 0, -0.77)** (north-east), **screen-right = R = (0.77, 0, 0.64)** (south-east). So +x runs up-right on screen and +z runs down-right; the whole map looks like a diamond.

### 0.2 Decisions on analyst contradictions

| Topic | Conflict | Decision | Evidence |
|---|---|---|---|
| Doctor height vs ring | ring = 0.62 H (seg_A) ... 0.9 H (seg_E, layout) | ring 1.6 m, doctor 1.9 m (ring = 0.84 of doctor height) | my measurements at 10.2 s and 23.4 s |
| Cauldron size and rim height | rim 0.6 dh above ground (seg_B/C) vs 2.0 m (layout); diameter 1.4-2.0 H | rim diameter 3.4 m, rim 1.7 m above ground, log ring radius 2.0 m | 10.2 s: rim ellipse 192x122 px, log ring 223 px wide, rim centre 65 px above the log-ring centre |
| Where the doctor stands to pour | "at the rim" (seg_A/B/E) vs 3.6-4.2 m north of the centre (layout) | 3.6-4.2 m from the centre (the rim is elevated, so on screen he looks adjacent) | 10.2 s ground-point reconstruction gives (0.3, -3.9) |
| "0/2" label position | (0.1, 2.25) (layout) | (-0.3, 3.0) | 10.2 s and 43.4 s reconstructions give z = 3.0-3.3 |
| Coin pallet position | (4.1, 2.6) layout; others 3.6-4.6 | (3.9, 3.0), just west of ward-1's corner post, touching the wood floor edge | 43.4 s reconstruction |
| Flasks per bubble | 4 (art), 5 (seg_A/B, dynamics); pile shows 10-12 | hand-size bubble: 10 flask meshes on the ground, **5 carried units**; cart-size bubble: about 18 on the ground, **9 carried units** (2 ground meshes merge into 1 carried flask) | my count at 7.2-7.4 s (10-11 on the ground), 43.4 s (9 in the stack) |
| Coins per cured patient | 50 (pickup 1) vs 25 (pickups 3, 4) | 25 gold per bathed patient; the very first batch pays double | pallet shows 4x6 coins at 16.6 s (+100), 4x6 at 33.4 s (+50), 4x12-13 at 48.6 s (+100) |
| HUD does not drop at the cart pad | counter stays 300 while 50 is visibly paid (35.27-36.17) | treated as an ad/build artefact; our game subtracts the price | dynamics, seg_D digit differencing |
| Beds and nurses in ward-1 | 4 (seg_B/C, layout) vs 7-8 (art) | 4 beds, 4 nurses | 22.2 s and 23.8 s frames |
| Ward-2 beds | 6 (seg_E, layout) vs 6-8 (dynamics) | 6 beds (2 columns x 3 rows), 6 nurses | 51.1-52.6 s |
| Player ring on the cart | hidden (seg_D) vs always visible (art) | hidden while mounted, visible again on foot (42.8 s) | 37-41 s and 42.8 s frames |
| Doctor on the cart | seated (seg_D/E) vs standing (art) | seated on the rear bench holding two levers | 40.4 s and 41.0 s crops |
| Grinder size | 6.2x2.7 m (seg_A via ring) vs 5.1x2.3 (layout) vs 5.0x2.1 (seg_D) | 5.1 x 2.3 m, long axis north-south | two independent pinhole fits agree |
| River width | 14 m (seg_A) vs 5-7 m (layout) vs 6.2-8.3 m (dynamics) | 7 m | 22-25 balls of 0.24-0.25 m across |
| Camera projection | near-orthographic (seg_A, art) vs perspective (others) | perspective, vertical FOV 38 deg | ring is 42 px semi-major high on screen, 58 px low on screen |
| Camera shake | none (seg_A/C) vs small shakes (dynamics, block matching) | small shakes exist (2-7 px) | dynamics per-frame background tracking |
| Doctor speed | 2-2.6 dh/s ... 9 H/s | 7.0 m/s cruise; the 10-17 m/s bursts late in the ad are treated as ad speed-up | section 11 |
| Why the bath stops at 47.9 s with liquid still high | unexplained (seg_E) | bath needs one free, unreserved bed per bather; all 4 ward-1 beds were reserved (inferred) | explains why the next purchase shown is "more beds" |
| Potion use | "about 2 of 5 per batch" (seg_B) vs 1 per patient (dynamics) | 1 potion unit per bather, cauldron capacity 10 units | a hemispherical-bowl fill model with capacity 10 reproduces all six measured liquid widths (section 2.6) |
| When a nurse starts treating (review) | "as soon as nurse and patient are both present" (first draft) vs frames | the patient must have been lying for `NURSE_START_DELAY` = 3.0 s (inferred value; at least 1.1 s is directly visible) before the nurse starts | bed A patient lies down at 33.4-33.6 s and is still untreated, with no bubble and the syringe upright, at 34.6 s (camera then leaves); bed A patient of batch 3 is lying untreated in every frame from 48.6 s (bed enters the frame) to 49.6 s, and he left the pot at 46.4 s, so he had probably lain since about 47.7 s (inferred from the 1.3 s walk of batch 1); the first pair had already lain 4.5-5 s when the nurses arrived, so they were treated at once (21.8 s) |
| Potion-request bubble at 43.2 s (review) | "visible whenever potion < 2" (first draft) vs frames | hidden while the doctor carries flasks unless the pot is completely empty | shown at 8.6-9.0 (pot empty, 5 flasks carried) and 32.6-33.0 (1 unit, nothing carried); absent at 42.8-43.6 (1 unit, 9 flasks carried, cauldron fully in view) |

---

## 1. Core loop

### 1.1 Player loop (everything except movement is automatic by proximity)

1. **Fetch a bubble.** Walk the wooden scoop into the river of small cyan balls. The scoop ploughs the small balls aside. Meet a big cyan bubble head-on with the concave side of the scoop; if the bubble fits the scoop it docks in it [SEEN 3.77-4.07]. A bubble that is too big shoves the doctor back and he shows a scared emoji [SEEN 1.40-2.80].
2. **Deliver it to the grinder.** Push the docked bubble onto the grinder tray; it is released automatically, cracks, shatters and comes out the other side as blue flasks [SEEN 5.25-6.97, 41.0-42.07].
3. **Pick up the flasks.** Walk near the pile; flasks fly onto the doctor's back as a tall vertical stack [SEEN 7.63-8.00, 41.97-42.93].
4. **Fill the cauldron.** Stand within 4.5 m of the cauldron; flasks fly from the top of the stack into the pot, the glowing liquid rises [SEEN 9.63-10.6, 44.10-44.77].
5. **Bring patients.** Before the usher is bought: walk to the pen bay, the fence gate opens and exactly 2 sick villagers walk to the cauldron [SEEN 11.85-13.05]. After the usher: villagers queue by themselves, 4 at a time [SEEN 29.9-30.7].
6. **Collect coins.** Bathed villagers shoot a fountain of coins onto a pallet [SEEN 14.67-15.73]; stand next to the pallet and the coins fly onto the doctor's back, the HUD counter rises [SEEN 18.33-19.20].
7. **Spend coins on floor pads.** Stand next to a price pad; coins stream from the back stack to the pad; when paid, the pad's unlock appears with a light burst [SEEN 19.73-20.8].
8. Repeat. The cart upgrade lets the doctor catch the biggest bubbles, which give almost twice the flasks [SEEN 36.2-44.7].

### 1.2 Automated loops

- **Bath loop** [SEEN 13.3-14.6, 30.9-32.3, 45.0-47.9]: when the cauldron holds potion, 2 queued villagers hop in, are cured in 0.5 s (radial progress icon), hop out on the far side, pay coins to the pallet and walk to a bed. One potion unit is consumed per bather.
- **Ward loop** [SEEN 14.6-16.9, 20.5-23.9, 33.4-34.8, 48.4-49.6]: a bathed villager (red glow = still wounded) lies in a free bed. If the bed has a nurse, she waits until he has lain for about 3 s (inferred; she is seen standing idle beside a lying patient for 1.0-1.1 s on two occasions before the camera leaves), then injects him with a giant green syringe (about 1.4 s) and he is healed, cheers and runs out.
- **Drill / rat loop** [SEEN 24.2-26.6]: healed villagers leave ward-1 by its south gate, grab the handle of a drill cart and push it into a swarm of black rats; dead rats burst into a heap of coins that flies straight to the HUD counter (+250).
- **Usher loop** [SEEN 29.1-30.7, 31.7-33.0, 45.8]: an attendant at the pen gate keeps a queue of up to 4 sick villagers standing at the cauldron.
- **Guide arrow** [SEEN 6.97-8.03, 15.63-18.53, 18.77-20.0, 33.27-33.73, 34.33-35.47, 48.40-49.13, 50.13-50.80]: one bobbing green arrow marks the next objective.

---

## 2. Entities and stations

Notation for state machines: `STATE -> NEXT (condition; duration)`.

### 2.1 Plague doctor (player)

Size: 1.9 m tall, body collision circle radius 0.4 m. Always shows a dashed lime ring (diameter 1.6 m) on the ground, hidden only while riding the cart [SEEN 36.8-42.3 hidden, 42.8 visible].

Modes:

- `ON_FOOT`: moves directly in the input direction. Cruise 7.0 m/s, acceleration 45 m/s2, deceleration 60 m/s2 (every walk in the ad is bell-shaped with 0.2-0.3 s ramps) [SEEN table in dynamics: 4.8-7.7 m/s averages, 7.3-8.3 m/s peaks on normal walks]. Turns almost instantly (900 deg/s). Faces the travel direction.
- `HOLD_SCOOP`: same speed (no slow-down while pushing or in the river [SEEN 3.47-5.27]). The heading turns toward the input direction at 400 deg/s [SEEN 80-110 deg in 0.20-0.33 s]; velocity = heading x speed x max(0.25, cos(angle between heading and input)). The scoop always points along the heading.
- `MOUNTED` (cart): cruise 5.0 m/s [SEEN 4.2-5.6 m/s, 37.6-40.7], acceleration 12 m/s2, heading turns at 130 deg/s [SEEN about 180 deg in 1.5 s, 38.3-39.4], velocity always along the heading. Ring hidden.
- Transient `PUSHED` (0.8 s): after an oversize bubble hits the hand scoop the doctor is carried along the bubble's velocity (4 m/s) while they touch, total 1-3.5 m [SEEN 1.4-2.7]; input still steers.

Carrying:

- **Flask stack** (section 2.5) and **coin column** (section 2.8) stand behind his back, anchor 0.45 m behind his centre, 0.3 m above ground. If both exist, flasks sit 0.3 m to his right and coins 0.3 m to his left [EXTENDED: never seen together].
- No carry limit was reached in the ad (9 flasks, 100 gold) [SEEN]. Flask limit 12 [EXTENDED].
- Carrying does not slow him [SEEN 8.13-8.57, 43.0-43.5].

Other: a warm point light travels with him (section 7.3). A pale dust arc appears behind the hem when he starts or turns sharply (6 frames) [SEEN 11.1, 33.57-33.77].

### 2.2 Tools: hand scoop and cart

Only one tool exists at a time. The cart replaces the hand scoop when pad C is paid [SEEN 36.17-36.6].

**Hand scoop** [SEEN 0.2-6.75 in use; 6.75-36.2 parked]

- Blade: curved plank wall, chord 2.6 m, sagitta (depth of the curve) 0.7 m, height 0.9 m rising to prow-like tips of 1.2 m, concave side forward; the collider is 0.12 m thick, the plank is drawn 0.28 m thick on the same centre line. Handle: A-frame of two poles and a crossbar, 1.0 m long. Blade centre is 1.15 m in front of the doctor.
- `PARKED -> HELD` (doctor comes within 1.1 m of the handle end, and the tool is "armed"). The tool is armed at game start (the doctor starts already holding it [SEEN 0.20]) and re-arms when the doctor has been more than 2.0 m away from the handle (inferred; a re-grab is never shown).
- `HELD -> PARKED` when (a) a docked bubble is released onto the grinder [SEEN 5.25-6.75: the scoop backs off 0.3 m, the doctor stays at the handle until the player walks away at 6.75, the scoop stays where it is], or (b) [EXTENDED] the doctor carries it out of the work area (x < 8.2): it is left at the boundary.
- Maximum bubble diameter it can capture: 2.8 m (captured 2.6 m; rejected 3.6 m) [SEEN 3.77, 1.40].

**Cart** [SEEN 36.25-49.8]

- Four-wheel wooden wagon, body 2.2 x 3.0 m, with a blade of chord 4.4 m, sagitta 1.1 m, height 1.1 m mounted 0.6 m in front of the body. Spawns at the hand scoop's position.
- `PARKED -> DRIVEN`: doctor comes within 1.2 m of the seat while armed; he dashes and hops onto the bench in 0.3 s [SEEN 36.83-37.30]. Arming as for the scoop (2.5 m).
- `DRIVEN -> PARKED`: after a bubble is released on the grinder, on the first movement input (he left the seat 3 frames after the crack [SEEN 41.20]); or [EXTENDED] at the work-area boundary. He hops off to the side in 0.15 s; the cart stays where it stopped [SEEN parked at the grinder 41.2-49.8].
- Captures every bubble size (max 4.2 m). On each capture a happy emoji shows over the driver 0.3 s after contact for 0.7 s [SEEN 39.17-39.87].
- The body collides with the grinder, boulders and walls; the blade passes over the grinder [SEEN 41.0].

**Ploughing** (both tools) [SEEN 0.9-1.6, 3.5-4.5, 37.5-40.9]: small balls collide with the blade, pack into a wedge 2-3 deep on the concave face, stream round both tips, and leave a bare lane as wide as the blade behind the doctor. The lane refills from upstream in 0.5-1 s. Balls bulldozed onto the bank stay there as static strays for 30 s or more [SEEN 8 strays at 5.0-7.9 s, 3-4 still there at 33.6-35.7 s].

### 2.3 River: small balls and big bubbles

**Small balls** [SEEN whole video]

- Glossy cyan spheres, diameter 0.24 m, one layer, 1,100-1,900 on screen at once; simulate **3,200** on the whole river (density up to 16 per m2 in dense zones).
- They flow continuously along the river centreline (section 4.3) even when untouched. Speed profile across the river: 0.9 m/s at the banks, 3.2 m/s mid-stream, times (1 + 0.5 p) where p = 0..1 is progress downstream (sparser and faster toward the fall) [SEEN 0.6-1.0 m/s banks, 1-2 m/s upstream body, 4.8-6.9 m/s downstream mid-stream].
- Behaviour: colliding spheres. They part around bubbles, the doctor (radius 0.45), tools and boulders; dark flow-aligned gaps and streaks are always present.
- At the south end they fall over a cliff as a curtain [SEEN 2.2-3.3] and are recycled at the north source.
- They are never collected and have no value [SEEN: balls pushed onto the grinder do nothing].

Recommended simulation (inferred, any equivalent is fine): per ball `vel = lerp(vel, flow(pos), 1 - exp(-dt/0.25))`, `pos += vel*dt`; then 2 relaxation passes of overlap resolution against neighbours (spatial hash, cell 0.3 m), bubbles, blade polyline (8 segments), doctor, cart body, boulders; a soft spring pulls balls back inside the bed unless they were pushed out by a tool, in which case a ball that rests outside for 0.5 s becomes a static stray (max 60 strays, oldest recycled after 30 s).

**Big bubbles**

- Glossy cyan spheres resting on the ground (centre height = radius). Three size classes: **S 2.0 m, M 2.6 m, L 3.6 m** diameter [SEEN 2.0 m at 2.0 s; 2.6 m caught by hand at 3.8 s; 3.6 m rejected at 1.4 s; 3.5-3.9 m caught by the cart at 39.2 s].
- Spawn at the north source every 0.4-2.9 s, mean 1.5 s [SEEN entries at 0.2, 1.0, 3.3, 4.6, 7.5, 35.0, 35.4, 36.4, 38.4, 40.6, 41.6]. Size mix 35 % S, 35 % M, 30 % L (inferred from 6 measured bubbles). At most 6 alive.
- Drift along the centreline at 4.5 m/s, 1.5-3 times faster than the balls around them, pushing a dense rim of balls ahead [SEEN 3.3-8.3 m/s across analysts]. Rigid, no wobble. They roll off the south cliff and vanish.

State machine:

- `DRIFT -> DOCKED` when the bubble touches the concave face of a held tool that has no bubble, its centre is laterally within (chord/2 - 0.2 m) of the blade axis, and its diameter is at most the tool's maximum. The bubble snaps to the socket in 0.1 s (3 smeared frames [SEEN 3.93-4.00]); 15-25 small balls burst up 0.8-1.3 m and outward for 0.27 s [SEEN 3.83-4.07].
- `DRIFT` + contact with a tool that is too small: no capture. The bubble keeps going, pushes the doctor (state `PUSHED`), camera shakes for 4 frames [SEEN 1.40-1.57], a scared emoji appears 0.5 s after contact for 0.9 s [SEEN 1.90-2.80].
- `DOCKED`: rigidly attached, centre at blade centre + forward x 0.85 radius; stays seated through turns [SEEN 4.1-5.25]. It keeps ploughing balls.
- `DOCKED -> ON_GRINDER` when its centre is inside the grinder rectangle grown by 0.5 m and the grinder is `IDLE`. It slides to the nearest point inside the tray (rectangle shrunk by 0.5 m) in 0.15 s and the tool is parked. If the grinder is busy the bubble stays docked.
- [EXTENDED] With a docked bubble the doctor cannot cross the work-area boundary (x < 8.2); he is simply blocked there.
- `ON_GRINDER -> destroyed` by the grinder timeline below.

### 2.4 Grinder

Rectangular tray 2.3 m (x) by 5.1 m (z) sunk into the dirt, with two parallel shafts of toothed steel discs along the long axis (2 rows x 20 discs). Blocks the doctor and the cart body. One bubble at a time.

- `IDLE`: discs turn slowly, 0.5 rev/s (inferred: seg_A saw the tooth highlights move, seg_D saw no rotation).
- `GRINDING` timeline, t = 0 when the bubble comes to rest [SEEN 5.40-7.2 and 40.93-42.2]:

| t (s) | Event |
|---|---|
| +0.20 | dark/white crack lines spread over the sphere (0.15 s); camera shake starts (0.35 s, section 9) |
| +0.35 | sphere becomes a faceted, lighter cyan shell, bulges 8 %, then squashes to 70-90 % height over 0.2 s |
| +0.50 to +1.30 | shell breaks into 25-35 angular shards that jitter, slump into the rollers and shrink to nothing; discs spin at 4 rev/s |
| +0.60 to +1.10 | flask meshes pop out of the west long side, one every 0.04 s, each hopping 0.8-2.2 m in a 0.5-1.0 m high arc (0.15-0.2 s), tumbling, landing on its side in the landing area |
| +1.30 | tray is free again (`IDLE`) |
| +1.3 to +2.2 | small cyan chips keep hopping on the rollers |

  Flasks started 1.2 s after rest with the hand scoop and 0.47 s after rest with the cart [SEEN 6.60 vs 41.40]; 0.6 s is used for both.
- Output: S bubble = 3 carried units, M = 5 [SEEN 9.60: 5 in the stack], L = 9 [SEEN 43.4-44.0: 9 in the stack]. Two flask meshes are ejected per unit [SEEN 10-11 on the ground at 7.2-7.4, about 18-20 at 41.8-42.0].

### 2.5 Flasks

- **Ground pile**: flask meshes lying on their sides at random angles in the landing area (centre (7.3, -2.5), 2.2 x 3.4 m), west of the grinder.
- **Pickup**: any pile flask within 1.6 m of the doctor flies to him (nearest first) as a blue streak of 0.1-0.13 s; every second arrival adds one upright flask to the top of the stack. Rate 14 units/s (5 units in 0.37 s [SEEN 7.63-8.00]; 9 units in 0.5 s [SEEN 42.43-42.93]). Nothing is left on the ground [SEEN 8.03].
- **Stack**: upright flasks, each neck tucked into the bulb above so that the bulbs touch, pitch 0.76 m at rest, only the top one shows neck and cork. Stack height at rest = (n - 1) x 0.76 + 1.2 m: 5 flasks = 4.2 m (2.2 doctor heights, measured: 210 px against a 97 px doctor at 9.5 s), 9 flasks = 7.3 m (about 3.8 times the doctor) [SEEN 9.5 bulb centres 38 px apart; 44.2 bulb centres 40 px apart]. It behaves like a lagging chain: bends back 35-40 deg while running (top trails 2.5-3 m), stretches up to 30 % (bulb centres 50 px apart at 44.0, the frame in which he stops, against 40 px at 44.2), whips upright within 0.10-0.15 s of stopping and settles to the rest pitch within 0.2 s [SEEN 8.1-9.5, 43.1-44.2]. The flasks themselves stay nearly upright (they tip a quarter of the chain's lean), so a running stack is a staircase of whole flasks with the necks showing beside the bulb above [SEEN 8.4-8.8]. The lean is strongest at the top link and dies out about four links below it: a 5-stack is one sheared line, a 9-stack stands upright on the back and curves away above [SEEN 43.4-43.8: links offset 24, 17, 19, 11, 6, 2, 1 px from the top down].
- **Deposit**: section 2.6.

### 2.6 Cauldron

Black iron hemispherical bowl on a log fire in the courtyard: rim diameter 3.4 m, rim 1.7 m above ground, collision circle radius 2.15 m (bowl plus log ring).

Variables: `potion` (0..10 units), `bathers` (0..2), capacity label "n/2".

**Deposit** [SEEN 9.37-10.6, 44.00-44.77]: when the doctor is within 4.5 m of the centre with at least one flask and `potion < 10`, after a 0.25 s delay the top flask launches every 0.08 s (0.10-0.12 s with 5 flasks, 0.067 s with 9). Each has a white flash at launch, rises 0.6 m, tumbles 180-270 deg and lands in the pot centre after 0.3 s. On landing `potion += 1`, a white-cyan plume plays, the liquid surface grows in 0.13 s. Flasks beyond capacity stay on the back.

**Liquid level** (matches all measurements): fill fraction f = potion/10; liquid depth h (fraction of the bowl radius) from the table, surface radius = 0.92 x rim radius x sqrt(2h - h2).

| potion | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| h | none | 0.27 | 0.39 | 0.49 | 0.57 | 0.65 | 0.73 | 0.80 | 0.87 | 0.93 | 1.00 |
| surface width / rim width | no liquid | 0.63 | 0.73 | 0.79 | 0.83 | 0.86 | 0.89 | 0.90 | 0.91 | 0.92 | 0.92 |

  Measured: 0.58-0.60 with 1 unit [SEEN 32.2, 43.8], 0.78 with 3 [SEEN 14.3], 0.90 with 5 [SEEN 10.6], 0.87 with 6 [SEEN 48.0], 0.90 with 8 [SEEN 46.4], 0.92 with 10 [SEEN 44.8].

**Potion-request bubble** (blue flask on a terracotta disc, red glowing outline, red "!" tick): shown above the cauldron while `potion < 2`, no deposit is in progress, and (the doctor carries no flasks or `potion == 0`) (rule inferred from three sightings). It scales out in 3 frames when the doctor enters the deposit radius with flasks [SEEN 8.2-9.23 with an empty pot and 5 flasks carried; pops in at 32.57 after the batch that left 1 unit, nothing carried; absent at 42.8-43.6 with 1 unit left and 9 flasks carried].

**Bath state machine**

- `EMPTY -> ENTERING` when: 2 villagers stand in queue slots 0 and 1, `potion >= 2`, and at least 2 beds are free and unreserved (inferred, see 0.2). Each bather reserves a bed. The pair waits 0.2 s at the west side [SEEN 13.07-13.27], their emoji bubbles shrink out (3 frames), then both leap over the west rim in a parabola (apex 1.2 m above the rim, 0.2 s), the second starting 2 frames after the first [SEEN 13.30-13.53, 30.93-31.13, 45.07-45.27].
- `ENTERING -> CURING` on landing: `potion -= 2`; splash and camera shake; the label flips from "0/2" to solid green "2/2" in one frame, never showing "1/2" [SEEN 13.57, 31.30, 45.37]; a cure bubble (white plus on a terracotta disc) scales in above the pot over 4-5 frames.
- `CURING` (0.5 s): the disc fills green clockwise from 12 o'clock [SEEN 0.47 s at 13.57-14.05 and 31.30-31.77; 0.55 s at 45.47-46.03]. Green shard particles fly off the bathers; at 85 % their skin changes from yellow-green to healthy.
- `CURING -> DONE` (0.25 s): icon becomes a white check on green, then shrinks out in 0.1 s [SEEN 14.27-14.43, 31.87-32.13, 46.10-46.33].
- `DONE -> EMPTY`: both leap out over the east rim (0.17 s) [SEEN 14.47-14.60, 32.07-32.30, 46.23-46.37]; label back to grey "0/2". Total time in the pot 0.95-1.0 s; with a waiting queue a new pair lands 1.53 s after the previous one [SEEN 45.37 -> 46.90].
- Each bather then pays (section 2.8) and walks to his reserved bed (section 2.10).
- [EXTENDED] End of the crowd: if the crowd is empty and fewer villagers than the bath has slots are queued, the batch starts after 1 s with whoever is queued (potion and bed checks per bather).

The doctor does not have to be present (inferred; he happened to be within 4.3 m at every batch shown).

### 2.7 Crowd, pen, gate, usher, queue

- **Crowd**: sick villagers packed shoulder to shoulder (pitch 1.0 m, staggered rows) on bright green ground west of the courtyard and of ward-1, all facing the cauldron, heads in hands, green miasma between them; about 80-110 visible at once [SEEN 11.8-12.4, 28.4, 51.6]. They idle (bob/sway) and never move as a mass. [EXTENDED] The crowd is finite: `TOTAL_VILLAGERS = 180`. When a villager is released, the instance farthest from the gate is removed so the visible part stays dense until late.
- **Pen bay**: a semicircle of bare sand (radius 2.6 m) bulging west from the courtyard's west edge, bounded by a low curved picket fence; the crowd presses against the outside.
- **Gate**: a 5-picket fence panel (1.6 m) at the west point of the arc, hinged at its south end [SEEN 12.0, 30.0]. It swings inward 90 deg in 0.25 s with a dust puff at the hinge [SEEN 11.97-12.2, 29.67-29.87] and closes 0.5 s after the last villager of a group has passed (inferred).
- **Manual release** (before the usher) [SEEN 11.85-12.4]: when the doctor is within 3.0 m of the bay mouth point (-4.6, -1.8), `potion >= 2`, no villager is already on the way or queued, and 2 beds are free: after 0.1 s the gate opens and exactly 2 villagers come out.
- **Usher** (pad B): a maid-like attendant runs from the pad into the bay and stands at (-5.35, -3.3), just inside the fence's north end, one arm stretched toward the cauldron [SEEN 29.13-29.87]. From then on villagers are released automatically, one every 0.25 s in single file [SEEN 29.93-30.30], while `queue length < 4`, at least one bed is free and unreserved, and the crowd is not empty. This keeps 4 queued [SEEN 30.73, 32.97, 43.8, 45.80] and explains the queue of only 2 after 47.9 s.
- **Queue**: slot i at (-2.8 - 1.0 i, -0.7 - 0.25 i), i = 0..3 (a line trailing west toward the bay, 1.0 m pitch [SEEN 30.73, 44.0]); [EXTENDED] the big cauldron's fifth and sixth place turn north along the fence inside the bay: (-6.2, -2.3), (-6.2, -3.2). Villagers walk at 5.5 m/s (gate to cauldron about 4.5 m in 0.65-0.8 s [SEEN 12.4-13.27]) and step forward when slots free up.
- A green sick-face emoji bubble pops over each villager as he passes the gate and follows him until he jumps [SEEN 12.33, 29.93-30.3].

### 2.8 Coins, pallet, wallet

- **Wallet** = the HUD coin counter (integer gold). Starts at 0 [SEEN 0.2].
- **Bath fee**: each bathed villager pays **25 gold**; the first batch of the game pays double (100 for 2) [SEEN +100 at 18.37-19.20, +50 at 33.83-34.33, +100 for four at 48.77-49.77].
- **Fountain** [SEEN 14.63-15.73, 32.30-33.2, 46.43-46.8, 47.9-48.8]: 0.1 s after a bather lands outside the pot a short column of bright yellow coins pops above him, then a wobbly rope of 10-15 coins at a time rises 2.6-3.0 m and arcs to the pallet (flight 0.4 s per coin, whole stream 1.0 s per batch). One coin mesh is worth 2 gold (25 meshes per pair, 4 gold each for the first batch).
- **Pallet**: 1.6 x 1.3 m wooden tray. Coins land round-robin on a 2x2 grid of stacks (first coin 14.83, one coin in every slot by 14.90, 6-7 layers by 15.73) [SEEN]; 12-13 layers after two batches [SEEN 48.6]. They fade in half-transparent, then solid. No capacity limit.
- **Pickup** [SEEN 18.30-19.20, 33.83-34.50, 48.77-49.77]: doctor within 1.9 m of the pallet centre. Coins leave all stacks top-first as one arcing chain (apex 1.8 m above the pallet, 8-17 airborne, 0.17-0.2 s each) onto the doctor's back. The wallet increases by 100 gold/s while coins leave the pallet (+4 per frame at 18.4-19.2; +3/+3/+4 at 48.8-49.8).
- **Back column**: one rigid vertical column of orange discs (diameter 0.55 m, 0.09 m each) behind the doctor, growing bottom-up. Show `min(70, ceil(carriedGold / 2))` discs, where `carriedGold` = gold picked up from the pallet and not yet spent [SEEN about 50 discs = 2.9 doctor heights for 100 gold at 19.2-19.6; 27-30 discs after paying 50 at pad A (20.6-27.0); 0 discs after paying 50 at pad B (28.4)]. The formula does not reproduce two later sightings, which is accepted (see section 12, item 2): after the +50 pickup at 33.8-34.4 the column is again about 50 discs tall (same height as at 19.6 once the 12 % zoom difference is removed) and pad C then consumes all of it (no column at 36.2); after the +100 pickup at 48.8-49.8 it is 50-58 discs (review pixel count; the first draft's "63-72" could not be reproduced). It leans at most 10 deg when braking. Gold that goes straight to the HUD (rats) adds no discs [SEEN 27.0: column unchanged while the HUD jumped by 250].
- **Rat coins**: section 2.10.

### 2.9 Price pads

Flat decals on the ground: four white arc brackets of a circle 1.9 m across, a white icon, a copper coin icon and the price lying on the floor.

- `HIDDEN -> POP_IN` at its trigger (section 3): white sparkle, scale 0 -> 1.1 -> 1 in 0.13 s [SEEN 17.10-17.27, 34.83-34.93].
- `IDLE -> PAYING` when the doctor's centre is within 2.4 m of the pad centre, he has slowed below 0.5 m/s for 0.1 s, and `wallet >= price` [SEEN he stands 1.8-2.6 m from the centre, never on it; payment starts 2-5 frames after he stops]. If he cannot afford it nothing happens [EXTENDED].
- `PAYING`: the wallet counts down linearly over `clamp(price / 135, 0.5, 0.9)` s (50 in 0.50 s at 19.73-20.23; 50 in 0.67 s at 27.77-28.43; 100 in 0.73 s at 50.33-51.07). Coins peel off the top of the back column at about 2 discs per frame, fly a parabola (apex 0.6-2 m above the column top, 0.2-0.3 s) and land on the pad centre, briefly stacking there; 10-15 airborne [SEEN]. `carriedGold` is reduced first; if the column runs out the remaining coins spawn from the doctor's belt [EXTENDED]. A solid green rectangle (2.0 x 1.5 m) fills the pad, wiping from the doctor's side in proportion to the amount paid (instant at pad A, 0.2-0.6 s at the others) [SEEN 19.87-19.97, 28.07-28.3, 35.60-36.00, 50.47-50.90]. The printed price never counts down [SEEN]. Leaving the radius pauses payment and keeps the progress [EXTENDED].
- `PAYING -> DONE`: 0-0.3 s after the last coin lands, 1-2 frames of pink/red sparks, the pad shrinks out in 2 frames, the unlock effect plays (section 9) and the unlock is applied.

### 2.10 Beds, nurses, drill and rats

**Bed** (4 in ward-1 from the start; 6 more in ward-2 after pad D): states `FREE`, `RESERVED`, `OCCUPIED`.

**Bathed patient** (after leaving the pot): healthy skin, grey-blue vest, a pulsing red glow on the lower back/head, hunched, clutching his stomach. Walks at 4.5 m/s past the west side of the pallet to his bed (first patient reached bed A 1.3 s after leaving the pot, the second reached bed C at 16.55-16.8) [SEEN 14.6-16.8]. Bed order: A, C, B, D, then ward-2 beds 1-6. He rolls onto the bed in 0.3 s and lies curled on his side on top of the blanket, glow still on.

**Without a nurse**: 0.15 s after lying down a "needs nurse" bubble pops above the bed head (nurse bust, cream fill, red outline) and stays [SEEN 16.43-21.63].

**Nurse** (one per bed, permanent): stands at bed centre + (0.6, +1.5) (south side, near the head) holding a giant green syringe upright; from afar this reads as a green vertical bar beside every bed [SEEN 21.5-27.1, 51.1-52.6]. She treats whenever her bed is occupied, but not at once: **t = 0 = max(time the patient lay down + `NURSE_START_DELAY` (3.0 s), time the nurse reached her post)**. Until t = 0 she stands idle with the syringe upright, the patient keeps his red glow and no bubble is shown [SEEN 33.5-34.6 at bed A: 1.1 s of idle waiting before the camera leaves; 48.6-49.6 at bed A: 1.0 s of idle waiting between the bed entering the frame and the camera leaving]. The delay value is inferred: directly visible lower bound 1.1 s; about 1.9 s if the batch-3 patient reached bed A 1.3 s after leaving the pot at 46.4 s, as the first patient did; upper bound about 11 s (inferred: the two batch-2 patients, in beds A and C from 33.5-34.4 s, must be gone before batch 3 can use those beds around 47.7 s; bed B is visibly empty from 45.0 to 48.6 s and batch 4's pair walks to beds B and D at 48.6-49.6 s). The first two patients had already lain 4.5-5 s when the nurses arrived, so their treatment started immediately. Timeline from t = 0 [SEEN 21.5-23.9]:

| t (s) | Event |
|---|---|
| +0.15 | bubble becomes a white plus on an orange/terracotta disc |
| +0.40 | syringe swings from vertical to horizontal in 3 frames and jabs the patient |
| +0.50 to +1.20 | green splash at the needle (0.2 s); patient tinted bright green with a green outline; syringe barrel drains from green to pale steel |
| +0.85 to +1.20 | disc fills green clockwise (0.37 s) |
| +1.40 | check mark; golden burst with 2-3 expanding rings, streaks, up-arrow glyphs (0.4 s); patient healed; syringe green and upright again |
| +1.60 | check bubble shrinks out (0.17 s) |
| +1.80 to +2.15 | patient sits up with one fist raised |
| +2.2 to +2.4 | hops off the bed; bed becomes `FREE` |
| after | runs out at 8 m/s |

**Healed patient**: from ward-1 he runs down the aisle to the south gate (two leaves, each swings outward 110 deg in 0.2 s) [SEEN 23.9-24.4]. From ward-2 he leaves by the north double door and goes home [EXTENDED]. A healed patient increments the `discharged` counter when he leaves the map.

**Drill sortie** [SEEN 24.2-26.6]

- The drill cart is parked just outside ward-1's south gate, handle toward the gate and cone pointing south, inside a dashed orange circle (radius 2.8 m, cut by the ward wall) that the rats never enter.
- Healed patients from ward-1 take the push handle; the crew size is 2. When 2 are at the handle and the swarm is ready, they push the cart 5.5 m south, out of the circle and into the swarm, in 0.9 s [SEEN 24.37-25.3: the crew is on the rim at 25.1 and 2 m outside it at 25.3] (the first one starts pushing alone at 24.40, the second joins at 24.60).
- From 0.4 s after the push starts [SEEN first coins 24.77], rats touched by the cone flash crimson for 3-5 frames and vanish; the cone glows orange-red, white sparks fly; coins fountain out radially (up to 3 m high) until 0.6 s after the cart has stopped (1.1 s of coins in all) and pile into a heap of several hundred discs about 8 x 7 m that buries the cart and crew [SEEN 24.63-25.90]; continuous small camera jitter.
- 0.1 s after the last coin lands, the whole heap lifts off, forms about 12 parallel curved ribbons and streams to the HUD coin icon in 0.5 s; the wallet counts +250 in 15 steps of +16.67 (0.47 s) [SEEN 25.97-26.60].
- Reward: **250 gold per sortie**, straight to the wallet. Afterwards the cart is back at its parking spot and the two crew walk away south and fade (discharged) [SEEN: cart and men no longer visible from 26.37].
- [EXTENDED] The swarm needs `RAT_REGROW = 20 s` to be ready again (rats trickle back in from the south and east edges). A healed ward-1 patient decides at the moment he hops off his bed: if the swarm is ready and the crew is not full he runs to the handle and waits there for a partner; otherwise (swarm regrowing, or crew already full) he walks out of the south gate, passes the parked cart on its west side and fades to the south (discharged) without touching the drill. He never waits for the swarm. A crew member who has waited alone at the handle for `DRILL_LONE_WAIT = 8 s` makes the sortie alone (same 250 reward), so nobody can wait forever and the win condition stays reachable. This matches the ad: the batch-2 patients hop off their beds around 38-40 s (by this spec's timing), 12-14 s after the first sortie paid out, and the HUD stays at 300 from 36.8 s to 48.6 s with no second +250 [SEEN HUD 48.2-48.6 = 300, then +100 from the pallet only].

**Rats**: black teardrop bodies 0.6 m long with two white ear wedges and a thin tail; 100-150 visible in one dense carpet around the dashed circle [SEEN 24.4-26.6]. They jitter in place and creep toward the gate at 2 m/s until they reach the circle. Ambient single rats: 3-4 grey ones idling in the derelict yard [SEEN 9-14, 27-31, 50.0-51.0], one with a glowing red eye running along the ward wall and near the pallet [SEEN 16.0-16.4, 17.7-18.8], 5 red-eyed ones among the trees north of ward-2 [SEEN 51.6]. Rats never harm anything in the footage.

### 2.11 Guide arrow

One chunky green 3D down-arrow. Target priority (inferred from seven appearances):

1. First flask pile of the game, from the last flask landing until the pickup starts [SEEN 6.97-8.03]. Later piles get no arrow [SEEN 41.4-42.9].
2. The pallet, whenever it holds coins and the fountain has ended, until pickup starts [SEEN 15.63-18.53, 33.27-33.73, 48.40-49.13].
3. A visible unpaid pad the player can afford, until payment starts [SEEN 18.77-20.0, 27.05-27.83, 34.33-35.47, 50.13-50.80]. The arrow may appear up to 0.5 s before the pad itself pops in [SEEN 34.33 vs 34.83].

It hovers 2.6-3.0 m above the target, pops in over 2-4 frames and shrinks out over 3-5 frames.

### 2.12 [EXTENDED] Helpers (unlocks E-I)

- **Porter** (pad E): attendant model. Loop: stand at (7.0, 0.4); when the pile has flasks and `potion < 10`, collect up to 6 units (same magnet effect), walk at 5 m/s to (2.4, -3.2), deposit like the player, return.
- **Bursar** (pad F): a small chest appears beside the pallet; 0.5 s after a fountain ends, pallet coins fly straight to the HUD in ribbons (same effect as rat coins).
- **Big cauldron** (pad G): bath slots 2 -> 4 (label "0/4", 4 hop in together, 4 potion per batch), potion capacity 10 -> 20, model scaled 1.15. Every "2" in the bath and release rules of sections 2.6 and 2.7 is `BATH_SLOTS`: a batch needs `BATH_SLOTS` queued villagers, `potion >= BATH_SLOTS` and `BATH_SLOTS` free unreserved beds; the potion-request bubble uses `potion < BATH_SLOTS`. To avoid long stalls, if the queue is full and potion is sufficient but only k free beds exist (1 <= k < `BATH_SLOTS`) for more than 2 s, a partial batch of k starts.
- **Drill Mk II** (pad H): sortie reward 250 -> 500, `RAT_REGROW` 20 -> 12 s, cone tinted gold.
- **Cart driver** (pad I): a healed-villager NPC with a cap drives the cart forever: park spot -> intercept the nearest bubble in the river -> push to the grinder -> repeat (cycle at least 8 s). The hand scoop reappears at (12.4, -1.5) for the player.

---

## 3. Progression and economy

### 3.1 Starting state [SEEN 0.2-11.4]

- Wallet 0. Doctor at (11.6, -2.6) holding the hand scoop, facing the river.
- River flowing with balls and bubbles. Grinder idle. No flasks anywhere.
- Cauldron empty (grey metal interior), potion-request bubble above it, label "0/2".
- Pallet empty. No pads visible. No arrow.
- Ward-1: 4 empty beds, no nurses. Yard north of the courtyard: derelict (crates, broken frames, idle rats), gate leaves open.
- Pen gate closed, no usher, crowd of 180 [EXTENDED count].
- Drill parked outside ward-1's south gate, rat swarm ready.

### 3.2 Unlocks in order

| # | Unlock | Price | Tag | Pad centre (x, z) | Icon | Pad appears when | Effect |
|---|---|---|---|---|---|---|---|
| A | Nurses | 50 | [SEEN appears 17.10, paid 19.73-20.23] | (1.65, 5.9), ward-1 floor at the foot of bed A | nurse bust with cap and plus | 0.2 s after the first bathed patient is lying in a bed with no nurse | 4 nurses appear in the light pillar at the pad and run (6.5 m/s, 0.9 s) one to each ward-1 bed, including empty beds |
| B | Usher | 50 | [SEEN visible 27.2, paid 27.77-28.43] | (-3.9, -2.5), courtyard tiles at the pen bay mouth | same nurse bust | after A is bought and the first drill sortie has paid out (inferred; the pad is absent at 11.8 and present at 27.2) | usher at the pen gate; automatic release; queue of 4 |
| C | Cart | 50 | [SEEN appears 34.83, paid 35.27-36.17] | (10.4, -6.9), dirt just north of the grinder | bulldozer/tractor with two cog wheels and a front blade | after B is bought, when the next pallet pickup completes | cart with the 4.4 m blade replaces the hand scoop at the scoop's spot |
| D | Ward 2 | 100 | [SEEN first seen 50.0, paid 50.33-51.07] | (-0.9, -5.4), tiles in front of the yard gateway | house with a cross and an up-arrow | after C is bought, the first time the bath is blocked because all beds are reserved, or when discharged >= 8, whichever comes first; absent at 46.0 with wallet 300 (trigger inferred) | yard props vanish, plank floor, 6 beds in 2 x 3 with 6 nurses pop in |
| E | Porter | 250 | [EXTENDED] | (7.3, 0.6) | figure carrying a flask | D bought and discharged >= 10 | section 2.12 |
| F | Bursar | 400 | [EXTENDED] | (4.0, 0.9) | chest with coin | E bought and discharged >= 20 | pallet coins auto-collect |
| G | Big cauldron | 600 | [EXTENDED] | (-2.7, 1.2), tiles south-west of the pot, clear of the queue and of the request bubble | cauldron with up-arrow | F bought and discharged >= 40 | bath 4 at a time, potion capacity 20 |
| H | Drill Mk II | 800 | [EXTENDED] | (1.8, 7.6), ward-1 aisle between the bed rows (no wall hides it, no nurse stands on it) | drill with up-arrow | G bought and discharged >= 60 | sortie reward 500, regrow 12 s |
| I | Cart driver | 1500 | [EXTENDED] | (12.6, -6.4) | figure on a cart | H bought and discharged >= 90 | automated bubble fetching |

The three "50" prices read toward the lower-right of the screen (text baseline along +z); the "100" reads toward the upper-right (baseline along +x) [SEEN].

### 3.3 Income

| Source | Amount | Goes to | Tag |
|---|---|---|---|
| Bath, per villager | 25 gold | pallet (player collects) | [SEEN 33.83, 48.77] |
| First bath batch of the game | 100 gold for the pair | pallet | [SEEN 18.37-19.20] |
| Drill sortie (2 healed villagers) | 250 gold | wallet directly | [SEEN 26.13-26.60] |
| Bed treatment | 0 | - | [SEEN: no coins leave the beds 22.9-24.2] |

Wallet trace in the ad, for regression testing: 0 -> 100 (18.37-19.20) -> 50 (20.23) -> 300 (26.60) -> 250 (28.43) -> 300 (34.33) -> [cart pad: unchanged at 300 in the ad; 250 in our rules] -> 400 (49.77) -> 300 (51.07).

### 3.4 Win condition and pacing [EXTENDED]

- **Win**: `discharged == TOTAL_VILLAGERS` (every villager bathed, treated in a bed and gone). Show "PLAGUE CURED", elapsed time (counted from the start button: the world already runs behind the title screen), total gold earned, and a replay button; golden light pillars burst over the courtyard and the camera pulls back 20 %.
- There is no fail state and no timer.
- Expected pacing: pads A-D within the first 60-90 s (as in the ad); with the cart one loop (fetch, grind, carry, pour) takes about 10 s and cures 9 villagers; the full game takes about 6-8 minutes. Total bath income about 4,600 gold plus about 15-20 sorties (3,750-5,000+), against 3,800 gold of prices, so everything is affordable before the end and the last phase runs mostly by itself.
- Optional persistence: save wallet, unlock flags and `discharged` to localStorage.

### 3.5 First-minute script (optimal play should roughly reproduce the ad)

| Ad time | Event |
|---|---|
| 0.2-5.3 | catch an M bubble, push it onto the grinder |
| 5.3-7.0 | grind; 5 flask units ejected |
| 7.6-8.0 | pick up 5 flasks |
| 9.4-10.6 | pour; potion 5 |
| 11.9-13.5 | manual release of 2; they hop in |
| 13.6-14.6 | cure; potion 3; 100 gold on the pallet by 15.7 |
| 16.0-17.2 | patients in beds A and C; pad A appears |
| 18.3-20.3 | collect 100, pay A (wallet 50); 4 nurses |
| 21.5-23.9 | both patients healed, run out |
| 24.4-26.6 | drill sortie, +250 (wallet 300) |
| 27.8-28.4 | pay B (250); usher; queue of 4 by 30.7 |
| 30.9-32.3 | batch 2; potion 1; request bubble at 32.6 |
| 33.8-34.3 | collect 50 (300); pad C appears |
| 35.3-36.2 | pay C; cart appears 36.3-36.6 |
| 37.3-41.0 | ride the cart, catch an L bubble, deliver |
| 41.4-44.8 | 9 flasks picked up and poured; potion 10 |
| 45.0-47.9 | batches 3 and 4; potion 6; beds full |
| 48.8-49.8 | collect 100; pad D |
| 50.3-51.1 | pay D; ward 2 with 6 beds and 6 nurses |

---

## 4. World layout

### 4.1 Coordinate system

- Origin: ground under the cauldron centre. +x east, +z south, +y up. Everything is on one flat plane y = 0, except the teal lowland south-east of the river fall (y = -1.5, decorative) and the gorge under the fall itself (6 m deep).
- All walls, floors, beds, pads and the grinder are axis-aligned. Rotation 0 deg = long axis along x.
- Accuracy of the measured positions: 0.3-0.5 m around the courtyard, 1 m in the wards and pen, 1.5-2.5 m for the river and the far north.

### 4.2 Top-down map

1 column = 0.5 m in x, 1 row = 1 m in z. On screen this map appears rotated: +x points up-right, +z points down-right; the map's top-right corner (river) is the top of the screen and its bottom-left (crowd) is the bottom of the screen.

```
z\x          -10       -5        0         5         10        15        20        25
 -23                                                                  ~~~~~~~~~~~~~~
 -22                                                                  ~~~~~~~~~~~~~~
 -21                               T                                  ~~~~~~~~~~~~~~
 -20                                   T               T             ~~~~~~~~~~~~~~
 -19             T           T                    T                  ~~~~~~~~~~~~~~
 -18                                                                 ~~~~~~~~~~~~~~
 -17                  |--------=======------|      T                ~~~~~~~~~~~~~~T
 -16                  |;;;;;;;;;;;;;;;;;;;;;|                       ~~~~~~~~~~~~~~
 -15                  |;;;;;bb4bb;;;;;bb1bb;|                   RR  ~~~~~~~~~~~~~~
 -14                  |;;;;;;;;;;;;;;;;;;;;;|                      ~~~~~~~~~~~~~~~
 -13                  |;;;;;;;;;;;;;;;;;;;;;|                 RR   ~~~~~~~~~~RR~~
 -12                  |;;;;;bb5bb;;;;;bb2bb;|   T                  ~~~~~~~~~~~~~~
 -11                  |;;;;;;;;;;;;;;;;;;;;;|       T        RR   ~~~~~~~~~~~~~~
 -10 ccccccccccccccccc|;;;;;;;;;;;;;;;;;;;;;|                     ~~~~~~~~~~~~~~
  -9 ccccccccccccccccc|;;;;;bb6bb;;;;;bb3bb;|              RR    ~~~~~~~~~~~~~RR
  -8 ccccccccccccccccc|;;;;;;;;;;;;;;;;;;;;;|                    ~~~~~~~~~~~~~~
  -7 ccccccccccccccccc|;;;;;;;;;;;;;;;;;;;;;|        [C]        ~~~~~~~~~~~~~~ #
  -6 ccccccccccccccccc||----...........-----|                   ~~~~~~~~~~~~~~ #   T
  -5 cccccccccccccccccc|......[D]..........       GGGGG         ~~~~~~~~~~~~~~ #
  -4 cccccccccccccccccc|...................   ffffGGGGG   S     ~~~~~~~~~~~~~~ #
  -3 cccccccccccccc(,,U....................   ffffGGGGG   S     ~~~~~~~~~~~~~~ #
  -2 ccccccccccccc(,,,,.[B]................   ffffGGGGG         ~~~~~~~~~~~~~~
  -1 cccccccccccccg,,,,........OOOOO.......   ffffGGGGG         ~~~~~~~~~~~~~~RR
   0 ccccccccccccc(,,,,.......OOOOOOO......                    ~~~~~~~~~~~~~~~
   1 ccccccccccccccc((,|.......OOOOO.......               RR   ~~~~~~~~~~~~~~~     T
   2 ccccccccccccccccc |...................                    ~~~~~~~~~~~~~~~
   3 ccccccccccccccccc |.......0/2......PPP                RR  ~~~~~~~~~~~~~~~RR
   4 ccccccccccccccccc |---::::::::::::::::---|                ~~~~ fall ~~~~~
   5 ccccccccccccccccc |::::::::::::::::::::::| """"""""""""""""""""""""""""""""""""""
   6 ccccccccccccccccc |::::bbBbbb::[A]:bbAbb:| """"""""""""""""""""""""""""""""""""""
   7 ccccccccccccccccc |::::::::::::::::::::::| """"""""""""""""""""""""""""""""""""""
   8 ccccccccccccccccc |::::::::::::::::::::t:| """"""""""""""""""""""""""""""""""""""
   9 ccccccccccccccccc |::::bbDbbb:::::bbCbb::| """"""""""""""""""""""""""""""""""""""
  10 ccccccccccccccccc |::::::::::::::::::::::| """"""""""""""""""""""""""""""""""""""
  11 ccccccccccccccccc |::::::::::::::::::::::| """"""""""""""""""""""""""""""""""""""
  12 ccccccccccccccccc |-------DDDDDDDDD------| """"""""""""""""""""""""""""""""""""""
  13 cccccccccccccccccc rrrrrrro          orrrrrr"""""""""""""""""""""""""""""""""""""
  14 cccccccccccccccccc rrrrrrro    DR    orrrrrr"""""""""""""""""""""""""""""""""""""
  15 cccccccccccccccccc rrrrrrrro        orrrrrrr"""""""""""""""""""""""""""""""""""""
  16 cccccccccccccccccc rrrrrrrrrroooooorrrrrrrrr"""""""""""""""""""""""""""""""""""""
  17 cccccccccccccccccc rrrrrrrrrrrrrrrrrrrrrrrrr"""""""""""""""""""""""""""""""""""""
  18 cccccccccccccccccc rrrrrrrrrrrrrrrrrrrrrrrrr"""""""""""""""""""""""""""""""""""""
  19 cccccccccccccccccc rrrrrrrrrrrrrrrrrrrrrrrrr"""""""""""""""""""""""""""""""""""""
  20 cccccccccccccccccc rrrrrrrrrrrrrrrrrrrrrrrrr"""""""""""""""""""""""""""""""""""""
```

Legend: `.` courtyard tiles, `:` ward-1 plank floor, `;` yard / ward-2 floor, `-` `|` walls, `=` north double door, `DDD` ward-1 south gate (two leaves), `b` bed (letter/digit = id, head to the east), `t` side table, `O` cauldron, `0/2` label, `P` pallet, `[A]..[D]` pads, `G` grinder, `f` flask landing area, `S` scoop rest / cart spawn, `RR` boulders, `T` conifers, `#` iron fence, `~` ball river, `"` teal lowland, `c` crowd, `(` pen fence, `,` pen bay sand, `U` usher, `g` pen gate, `DR` drill, `o` dashed circle, `r` rat field.

### 4.3 Landmark table

| Landmark | Centre (x, z) | Footprint (x by z) / size | Notes | Confidence |
|---|---|---|---|---|
| Cauldron | (0, 0) | rim diameter 3.4, rim height 1.7, log ring radius 2.0 | collider radius 2.15 | high |
| Doctor's pouring spots seen | (0.2, -3.6), (0.7, -4.2) | - | north side; deposit radius 4.5 | high |
| "0/2" label | (-0.3, 3.0) | 2.1 by 0.9 | text baseline along +x | medium-high |
| Queue slots 0-3 | (-2.8, -0.7), (-3.8, -0.95), (-4.8, -1.2), (-5.8, -1.45) | 1.0 pitch | bathers leap from slots 0 and 1 | medium |
| Bath seats | (-0.55, -0.25), (0.55, 0.3) | - | bathers stand chest-deep | medium |
| Bath exit points | (2.9, 0.4), (2.8, 1.3) | - | then waypoint (3.0, 3.8) into ward-1 | medium |
| Courtyard tiles | x -5.1..4.85, z -6.1..4.0 | 10.0 by 10.1 | tiles 0.85 m, aligned to x/z; east side open, pale curb strip | high |
| Coin pallet | (3.9, 3.0) | 1.6 by 1.3, 0.15 high | 2x2 stacks at +-0.31 | high |
| Ward-1 floor | x -4.9..6.5, z 4.0..12.3 | 11.4 by 8.3 | planks run along x; no roof; north side open for 8 m | medium-high |
| Ward-1 beds | A (4.1, 5.8), C (4.1, 9.5), B (-1.3, 5.8), D (-1.3, 9.5) | 2.7 by 1.7 | head toward +x | medium-high |
| Nurse posts | bed centre + (0.6, 1.5) | - | | medium |
| Side table with basin | (5.6, 7.7) | 0.8 by 0.8 | against the east wall between A and C | medium |
| Ward-1 south gate | (1.1, 12.3) | 4.2 wide (x -1.0..3.2), 2.0 high, low arch | two dark leaves hinged on the posts at x -1.0 and 3.2, opening outward; closed it is the "dark arched section" of the wall [SEEN 23.8, 24.4, 25.3] | medium |
| Drill parking | (1.95, 14.4) | 2 by 4 | cone toward +z (south); crossbar at (1.95, 13.4); sortie ends at (1.95, 19.9) | medium |
| Dashed circle | (1.8, 13.6) | radius 2.8 | clipped by the wall [SEEN 26.5: ten dash positions fit this circle within 0.1 m] | medium |
| Rat field | annulus radius 2.9..8 around the circle, z > 12.7, x -5.5..7.4 | - | unreachable for the player; the dirt ends at the plateau edge at x about 8 | low |
| Grinder | (9.65, -2.85) | 2.3 by 5.1 (x 8.5..10.8, z -5.4..-0.3) | long axis along z | high |
| Flask landing area | (7.3, -2.5) | 2.2 by 3.4 | west of the grinder | medium |
| Scoop rest / cart spawn | (12.4, -3.5) | - | blade parallel to the grinder, handle toward the river | medium |
| Doctor start | (11.6, -2.6) | - | holding the scoop | medium |
| Permanent stray balls | (12.4, -1.0) | 6 balls in 0.8 m | [SEEN 7.4-37.0] | medium |
| Pad A | (1.65, 5.9) | 1.9 across | | medium |
| Pad B | (-3.9, -2.5) | 1.9 across | on the tiles, west bracket about 0.3 m from the bay's straight sand edge [SEEN 27.6, 28.6] | medium |
| Pad C | (10.4, -6.9) | 1.9 across | | medium-high |
| Pad D | (-0.9, -5.4) | 1.9 across | | medium-high |
| Pen bay | (-5.1, -1.3) | semicircle radius 2.6 toward -x | sand floor [SEEN 29.6: thirteen fence points fit this circle] | medium |
| Pen gate | (-7.69, -1.07) | 1.6 wide (5 pickets) | 5 deg south of west on the arc; hinged at its south end, swings inward | medium |
| Manual-release trigger | (-4.6, -1.8) | radius 3.0 | | medium |
| Usher post | (-5.35, -3.3) | - | 1.65 m from pad B [SEEN 28.6-30.0] | medium |
| Crowd | x < -5.6 for z -10..20 and beyond | 1.0 m staggered pitch | extends off-screen west and south | medium |
| Yard / ward-2 | x -5.3..5.4, z -16.5..-6.1 | 10.7 by 10.4 | dirt, then planks | medium |
| Yard gateway (south side) | x -3.0..2.9 at z -6.1 | 5.9 wide | two leaves swung open inward before the upgrade | medium |
| North double door | (0.6, -16.5) | 3.3 wide | closed; opens for healed ward-2 patients [EXTENDED] | medium |
| Ward-2 beds | 1 (3.4, -15.2), 2 (3.4, -12.2), 3 (3.4, -9.2), 4 (-1.6, -15.2), 5 (-1.6, -12.2), 6 (-1.6, -9.2) | 2.7 by 1.7 | head toward +x | medium |
| Yard props (before D) | crates (4.4, -15.8) and (4.3, -14.6); flat frame (2.9, -13.5) 1.8 by 3.7; bench/cot (-0.7, -10.6) 2.6 long; dry reeds (1.5, -7.4); idle rats (1.0, -8.7), (1.8, -9.4), (2.5, -10.2), (4.8, -13.4) | - | removed by pad D | low-medium |
| River centreline | (22.0, -24) -> (20.5, -14) -> (18.6, -6) -> (18.5, 0) -> (18.5, 4.2) | half-width 3.2 (north) to 3.8 (south) | flows north to south; west edge at x = 15 beside the grinder | medium near, low far |
| River fall / cliff lip | z = 4.2, x 14..23 | drop 6 (the gorge under the fall; 1.5 elsewhere) | balls fall as a curtain down a smooth dark face [SEEN 2.4-2.8] | low-medium |
| Bank boulders (west) | pair (13.2, 1.2), (13.6, 2.6); row (13.5, -8.5), (14.3, -10.5), (15.0, -12.5), (15.8, -14.5) | 1.5-2.5 each | gap z -7..0 is the river entry | medium |
| Bank boulders (east) | (22.6, -13), (23.0, -9), (22.8, -1), (22.8, 2.5) | 1.5-2.5 | | low |
| Iron picket fence | (22.9, -5) | 5 long, 1.2 high | east bank | low |
| Teal lowland | x > 7.5, z > 4.5 | - | y = -1.5; a thin trickle of balls runs across it toward the south-west | low |
| Conifers | (7.5, -11.8), (9.4, -11.2), (8.8, -16.8), (8.3, -18.5), (-2, -19.5), (3, -20), (11, -20), (1, -21.5), (-8, -19), (24.5, -17), (25, -6), (25, 1) | 1.5-2 wide, 2-3.5 tall | | low |
| Cliffs / giant boulders | arc north and north-east, z < -21 and x > 24 | 3-6 m blocks | backdrop | low |

### 4.4 Walls (2.0 m high, 0.35 m thick; square posts 0.6 m, 2.3 m high with a flat cap at every corner, wall end and every 4-5 m)

| Segment | From -> to |
|---|---|
| Yard west | (-5.3, -16.5) -> (-5.3, -6.1) |
| Yard north | (-5.3, -16.5) -> (-1.05, -16.5), double door, (2.25, -16.5) -> (5.4, -16.5) |
| Yard east | (5.4, -16.5) -> (5.4, -6.1) |
| Yard south stubs | (-5.3, -6.1) -> (-3.0, -6.1) and (2.9, -6.1) -> (5.4, -6.1) |
| Courtyard west, north part | (-5.2, -6.1) -> (-5.2, -3.9) (post Pw) |
| Pen fence | picket arc radius 2.6 around (-5.1, -1.3) from (-5.1, -3.9) through west to (-5.1, 1.3); pickets 1.0 m high |
| Courtyard west, south part | post Pa (-5.05, 1.6) -> post Pb (-4.85, 4.05) |
| Ward-1 west | (-4.9, 4.05) -> (-4.9, 12.3) |
| Ward-1 north-west stub | (-4.85, 4.05) -> (-3.25, 4.05) |
| Ward-1 north-east stub | post P1 (4.8, 3.85) -> post P2 (6.4, 3.8) |
| Ward-1 east | (6.5, 3.8) -> (6.5, 12.3) |
| Ward-1 south | (-4.9, 12.3) -> (-1.0, 12.3), double gate -1.0..3.2, (3.2, 12.3) -> (6.5, 12.3) |

### 4.5 Walkable area and blockers

- **Walkable** [SEEN walked]: courtyard tiles; the dirt between courtyard, grinder and river; all around the grinder; the river itself (the doctor wades at least 4 m in [SEEN 1.0-4.6], the cart drives well into it [SEEN 38.2-40.0]); the north edge of ward-1's floor. (inferred) The rest of ward-1, the yard / ward-2 and the dirt north-east of the courtyard are also walkable.
- **Outer bounds** [EXTENDED]: x -5.0..21.8 (east bank closed by boulders and fence), z -21..(cliff lip 4.2 east of x = 6.9; ward-1 south wall otherwise).
- **Blockers** (inferred; no collision is shown): walls, posts, closed doors, pen fence, cauldron circle (2.15), beds, side table, pallet, grinder rectangle, boulders (circles), conifers (radius 0.5), yard props, parked cart body (radius 1.3). The parked scoop does not block.
- The player cannot pass ward-1's south gate or reach the rat field.
- **Tool work area** [EXTENDED]: x >= 8.2. Tools cannot be taken west of it.
- NPCs follow fixed waypoints, ignore the player, and keep 0.5 m soft separation from each other.

NPC routes: gate (-7.69, -1.07) -> bay (-5.6, -1.4) -> queue slot; bath exit -> (3.0, 3.8) -> bed side (bed centre + (-0.9, 1.1)) -> bed; ward-1 bed -> aisle -> (1.1, 11.3) -> south gate -> drill handle (1.95, 13.4); ward-2 bed -> (0.6, -15.6) -> north door -> (0.6, -22) fade.

---

## 5. Camera

- **Projection**: perspective, vertical FOV 38 deg (range 35 +-5) for a 9:16 portrait viewport [SEEN: ring semi-major 42 px high on screen vs 58 px low; grinder 256 px long at y = 347 vs 342 px at y = 685].
- **Angles**: pitch 40 deg below horizontal; fixed yaw: the camera sits south-west of the target and looks north-east along the ground direction (0.64, -0.77). No rotation ever [SEEN: wall slopes constant in every shot]. (seg_D suspected +-10 deg of yaw drift during the cart ride; not adopted.)
- **Position**: `camera.position = target + (-13.1, 17.2, 15.8) * zoom`, `lookAt(target)`; distance 26.8 m at zoom 1 (the 1.6 m ring is then 94-98 px wide around mid-height; the ad's median is 97 px [SEEN 13 frames, 8.6-50.2]). Ground coverage at zoom 1: 10.8 m across at the screen centre, 17.0 m across at the top row, 7.5 m at the bottom row, about 30.5 m top to bottom.
- **Target**: `doctor.position + (1.2, 0, -0.7) + velocity * 0.12 s`, so the doctor sits about 35 px left of and 50 px below the screen centre [SEEN ring centre typically x 170-390, y 490-700]. From there the target is pulled toward the station he is using, by rank: (1) a visible pad he can afford or is paying, within its pay radius, 60 % toward the pad's aim (pad A: the ward shot (3.87, 6.4); pad B: (-3.1, -4.1); pad C: (11.3, -5.2), between the pad and the scoop's rest; pad D: (-0.7, -9.0), the yard behind it; the other pads: the pad itself) [SEEN 19.6-20.0, 27.8-29.8, 35.2-36.0, 50.4-50.8]; (2) the pallet while it holds or receives coins (until the bursar takes it over), within the pickup radius, 60 % toward (4.8, 2.5) [SEEN 18.4-18.8, 33.6-34.4]; (3) the pen bay while patients are let out by hand, within the release radius, 60 % toward (-3.45, 0) [SEEN 11.8-12.2]; (4) the grinder, within 6 m of its centre (fading out to 9.5 m), toward the midpoint of the tray and the flask landing area: 35 % while a tool carries a bubble, 50 % while it grinds and while the pile waits for him (60 % seen from the cart's seat) [SEEN 5.4-7.0, 41.0-41.4]; (5) otherwise the cauldron, inside the deposit radius (fading out over 3 m), 70 % toward (0.3, -0.5), so pot, queue and bath exit share the frame [SEEN 9.6-10.6, 13.2-14.4, 30.6-33.0]. A station of higher rank displaces the lower ones; pulls outside a radius fade over 1.5 m and change through a critically damped spring (about 0.6 s). A pull falls only while the doctor walks: what he has just used stays framed until he moves on [SEEN 28.4-30.0 after pad B].
- **Follow**: critically damped smoothing with time constant 0.2 s; the camera starts about 3 frames after he starts and stops when he stops [SEEN 30.17-30.63, 33.13-33.73]. On the cart the bias is replaced by a look-ahead along the cart's heading: 2.0 m (the wagon), or 66 % of the way to a docked bubble's centre, so cart, blade and bubble are in frame together [SEEN 37.0-40.6].
- **Zoom**: a base zoom that follows the progress, changing at 12 % per second with eased ends: 1.16 from the start until the first flask is made [SEEN 0.2-6.4: 1.10-1.19, from the grinder's size], 1.0 afterwards [SEEN ring 8.6-50.2: 0.90-1.05], and [EXTENDED] 1.12 from the ward-2 unlock on, because the map in use is larger (the ad zooms out about 15 % at that moment [SEEN 51.00-51.10]). A pan's zoom multiplies the base.
- **Scripted pans**. The player keeps control of the doctor throughout. A pan that is cancelled eases out from where the camera stands at that moment [EXTENDED cancel rules]:
  1. First bath batch (once): follow the two patients from the pot to their beds, no farther than the ward shot (3.87, 6.4), hold until 0.6 s after pad A has popped in, return in 0.4 s [SEEN 14.6-17.7]. It starts when the doctor has stood still on foot for 0.25 s, or while he walks if he is near enough to stay in the shot (the ad's player walks to the pot's south side meanwhile and ends up at the frame's left edge).
  2. Nurse unlock: ease to the ward shot in 0.5 s (1.4 m from pad A's framing) [SEEN 20.47-20.97] and stay while a ward-1 bed is in use (at most 8 s) [SEEN 20.97-24.17 static], then return in 0.8 s or hand over to pan 3.
  3. First drill sortie (once, only for a doctor who has stood still on foot for 0.25 s): from the moment the first healed patient runs for the handle, ease over 1.1 s to (drill parking + (1.4, 0.8)) at zoom 1.04, hold until the heap is paid out, return in 0.3 s [SEEN 24.17-26.93]. Any movement input cancels it.
  4. Cart unlock: snap toward the cart in 0.25 s, hold 0.9 s, return in 0.8 s [SEEN 36.17-36.40].
  5. Ward-2 unlock: whip in 0.2 s to the six beds' centre + (0.5, 0.4), zoom 1.05 on top of the rising base, hold 1.5 s, return in 0.8 s; the doctor is left in the bottom-right corner [SEEN 51.00-52.63].
  6. [EXTENDED] Unlocks E-I: ease to the pad in 0.3 s, hold 0.7 s, return in 0.8 s. The usher unlock has no pan [SEEN 28.0-29.8 static].
  7. [EXTENDED] Win: ease to the cauldron in 1.2 s with zoom 1.2 and stay.
  Pans 1, 2 and 4-6 are tethered: while the doctor moves the camera keeps him inside the frame (ring centre within 92 % of the half-width, between 50 % above and 72 % below mid-height), so a reveal is seen even by a player who keeps walking; such a pan is cancelled only when he walks out of the shot (against the frame's edge, away from the focus), and not before ease-in + 0.5 s (pan 1: 1 s). While he stands the camera may leave him, as in the ad.
- **Recurring drift** (optional): while a coin fountain is flying and the doctor is idle, the camera drifts up to 2 m toward the pallet [SEEN 48.0-48.5].
- **Shake**: section 9.
- **Desktop / landscape** [EXTENDED]: render the game in a centred 9:16 viewport with dark side bars, so framing and HUD match the ad. A window too short for that (the 9:16 frame would be under 280 px wide: a phone held sideways) is filled instead; `F` or `?wide=1` does the same anywhere. The filled view keeps the vertical field of view and shows more ground to the sides; the HUD keeps its 9:16 size (never under 360 px wide) and sits centred with its bar running edge to edge.

---

## 6. Controls

- **Touch / mouse (as in the ad: one-finger drag, nothing else)**: pointer down anywhere (the side bars included) sets a floating joystick origin; the drag vector gives direction and analog magnitude (full speed at 40 px; past that the origin follows the finger, so turning back responds at once [EXTENDED]); release stops. A second finger that goes down takes the stick over, and when it lifts a finger that is still down takes it back [EXTENDED]. No joystick graphic, cursor or button is drawn in the ad [SEEN whole video]; an optional faint ring at the touch origin is acceptable [EXTENDED].
- **Mapping**: screen-up drag moves along F = (0.64, 0, -0.77), screen-right along R = (0.77, 0, 0.64); `move = normalize(dx * R - dy * F)`.
- **Keyboard** [EXTENDED]: WASD and arrow keys with the same screen-relative mapping (W = screen-up), diagonals normalised. Optional gamepad left stick.
- **Everything else is automatic by proximity**: grabbing/parking tools, mounting the cart, capturing and releasing bubbles, picking up flasks, pouring, releasing patients, collecting coins, paying pads.
- [EXTENDED] `M` toggles sound, `F` toggles the filled view, `R` restarts after the win screen; Enter / Space start the game and play again from the win screen.

---

## 7. Art

### 7.1 Style

Stylised low-poly 3D with chunky simplified shapes, flat or toon shading, a thin near-black outline (0.02-0.03 m inverted hull or post outline) on silhouettes of props, rocks, walls, coins, tools, the cauldron rim and characters. Gloomy night-time plague village: the environment is strongly desaturated (5-20 % saturation); all gameplay objects (cyan balls and bubbles, blue flasks, orange coins and fire, blue crowd, lime UI) are bright and saturated.

### 7.2 Palette

| Hex | Role |
|---|---|
| #6e6b62 / #88857c / #4f4e4a | dirt: mid / lit near the player / far |
| #848691 / #a69b9a / #797682 / #4d4850 | courtyard tile: base / warm-lit / shaded / grout |
| #77655b / #937461 / #433843 | plank floor: base / lit / seam |
| #7d6f67 | sand in the pen bay |
| #455160 / #565c63 | river bed where balls are cleared |
| #2e4d48 / #3a5954 | teal lowland |
| #606662 / #7d8180 / #313b3a | boulders: mid / lit facet / shaded facet |
| #3b464c / #1c292f / #0d1720 | cliffs / far darkness / fog |
| #4f6163 / #435556 / #2b3637 | conifers: lit / mid / shade |
| #55555d / #312f3a / #3e4145 / #9e8387 | walls: lit / shaded / top / post caps |
| #16959e / #3cd6da / #155e6a | small balls: mid / highlight / shade |
| #16bdc8 / #c0fefe / #0b7486 | bubble: body / highlights / shade |
| #1cb5bf / #75faf9 / #0b7486 | crystal shards: mid / lit / dark |
| #49b3e4 / #72e0f8 / #2791cf / #79664a | flask: mid / light / swirl / cork |
| #aaf3f7 / #d2f7f7 | potion surface / foam |
| #3d2e3b / #4c484a / #c7bfb6 | cauldron: outside / inside metal / inside bright centre |
| #664b48 / #453738 | fire logs |
| #e7853e / #ef961e / #aa522b | fire: mid / brightest / dark |
| #d98c47 / #f4a361 / #a35819 | coin: face / rim / emboss |
| #cf8f58 / #9e6039 / #5d371c / #e0a670 | scoop wood: light / mid / grain / end grain |
| #835b43 / #473b36 / #303c49 / #86593a | cart: wood / dark panels / wheels / gears |
| #666874 / #9c9fab / #2c2d33 | grinder discs: steel / highlight / gaps |
| #7e7d75 / #56453e | grinder tray rim / inner wall |
| #403c43 / #313947 / #fbf3f5 / #d4d4d9 | doctor: coat / skirt / hat / beak |
| #986072 / #d27ab8 | doctor's pouches: maroon / magenta |
| #5876b1 / #7697d0 / #6f4e53 / #a4aa5e | sick villager: shirt / shirt light / hair / sick skin |
| #9fa1bd / #e8e4e0 / #837d90 / #e1b1a6 | bathed villager: vest / shirt / trousers / healthy skin |
| #4ea459 / #1b652b | miasma |
| #f65c69 | red wounded glow |
| #a33e4e / #3d2d37 / #58fb6c | nurse: hair / skirt / syringe liquid |
| #ca9399 / #453b3d | usher: hair / skirt |
| #343237 / #f5f6f8 / #c93e65 | rat: body / ears / red eye glow |
| #828387 / #b1b7bd / #201922 | drill: steel / highlight / wheels |
| #a8686f / #e2c3c0 / #7c6054 | bed: blanket / pillow / frame |
| #353135 / #736769 | pallet: frame / planks |
| #24ee34 | UI green fill (label, pad fill, progress pie) |
| #5aff2e / #92fe5b | guide arrow: face / bevel |
| #b9f567 | doctor's dashed ring |
| #af694f | terracotta icon disc |
| #f0e1c9 | cream bubble fill |
| #ac2b3c / #c34b66 | red outline of alert bubbles |
| #ffda98 | dashed circle at the drill |
| #f4c671 / #fcdd88 | golden unlock light: body / core |
| #272f34 | HUD bar |

### 7.3 Lighting

- Night scene. Hemisphere/ambient light cool blue-grey (#8a93a8 sky, #3a3d48 ground), intensity about 0.6.
- Key directional light, cool-neutral (#cfd8ff), coming from screen upper-left, i.e. from the north: position `target + (-3, 20, -14)`, intensity about 0.9. Highlights sit at the upper-left of spheres [SEEN 0.4].
- **Lantern**: warm point light (#ffd9a0) parented to the doctor at y = 2.2, range 9 m; the dirt is #af957e at 0.8 m from him, #777569 at 3.5 m, #4f4b4b at 7 m [SEEN 0.2].
- **Fire**: orange point light (#ff8a3c) at the cauldron base, range 7 m, intensity flickering +-20 % at 8-12 Hz.
- **Potion**: cyan point light (#9ff5ff) at the liquid surface, range 5 m, intensity proportional to potion.
- **Shadows**: no crisp cast shadows. Soft dark blue-grey blob decals (multiply about 0.55) under the doctor (offset 0.2 m to the south-east), NPCs, beds, pallet, grinder, walls and rocks.
- **Fog and vignette**: fog colour #0d1720 from 30 m to 65 m; screen-space vignette darkening the corners to 45-50 % and the top edge to 60 % [SEEN mean luminance 135 centre vs 56-70 bottom corners].
- Emissive (unlit) materials: potion, flasks, fire strands, syringe liquid, coins in flight, all UI decals and bubbles.

### 7.4 Models from primitives (metres)

**Doctor** (1.9 m; about 4 heads tall; no legs visible)
- Skirt: cone frustum, bottom radius 0.38, top radius 0.20, height 0.95, slate #313947, thin lighter hem line.
- Torso: tapered cylinder radius 0.22 -> 0.26, y 0.95..1.45, charcoal #403c43, two columns of 2-3 pale studs.
- Arms: two capsules radius 0.07, length 0.55, hanging 20 deg outward; lighter cuffs #8c8c94; dark gloves.
- Belt at y 0.95 with two small boxes (0.12): maroon on one hip, magenta on the other.
- Head: sphere radius 0.16 at y 1.60, dark hood #3a373e. Beak: cone length 0.25, base radius 0.07, pointing forward and 30 deg down, bone white.
- Hat: brim disc radius 0.33, thickness 0.04 at y 1.72; crown cylinder radius 0.19, height 0.14 (top at 1.90); black band; feather: thin cone 0.3 long tilted back 20 deg (tip at 2.15). Cream #fbf3f5.
- Poses: idle (upright, arms slightly out); run (lean 12 deg forward, skirt hem flares to 1.5-2 times its width and swings); push (lean 30 deg, both arms on the crossbar); seated (on the cart bench, hands on levers).

**Hand scoop**: blade = 8-10 segments along a 120 deg arc (collider 0.12 thick; drawn as a chunky 0.28 slab centred on it [SEEN end face 16-19 px against the 84 px ring, 0.2 / 6.0]), chord 2.6, height 0.9 at the centre rising to 1.2 at the prow-like tips, top edge slightly wavy, painted horizontal grain lines. Handle = A-frame of 2 poles (0.15 thick) from the back of the blade converging to a 0.75 m crossbar at chest height (1.16), clearly paler wood than the blade.

**Cart**: chassis box 2.0 x 0.35 x 2.8, dark brown; rear bench = plank seat on two bearers, open underneath so that the rear wheels show whole, with a low backrest board 0.7 high that the seated driver's shoulders and hat clear [SEEN 37.0, 38.0] (teal strip across its back); 4 spoked wheels (torus + 6-8 thin boxes), rear diameter 1.0, front 0.8, dark blue-grey; two bronze cog cylinders (diameter 0.5) on a cross axle in the middle; two pale levers (1.2 long) reaching back to the driver; two arms forward to the blade. Blade as the hand scoop scaled: chord 4.4, height 1.1, tips curling up like a boat bow.

**Small ball**: sphere diameter 0.24 (8x6 segments), one InstancedMesh, cyan with a baked upper-left highlight (matcap or high-shininess Phong).

**Bubble**: sphere diameter 2.0 / 2.6 / 3.6, body #16bdc8, darker lower-right, two soft white highlight blobs at the upper-left (one large oval, one small), thin lighter rim (fresnel). Opaque is fine.

**Shards**: 25-35 icosahedra/tetrahedra with random non-uniform scale 0.3-1.1, flat shaded.

**Grinder**: rounded box frame 2.3 x 0.25 x 5.1 with rim 0.2 wide, dark inset floor 0.1 below ground; 2 rows x 20 discs: cylinders diameter 0.85, thickness 0.12, axis along z, pitch 0.235, rows centred at x = +-0.5 from the tray centre, only the top half above the tray floor; 10-12 small pale teeth per disc.

**Flask**: round-bellied: sphere diameter 0.65 + short concave shoulder + straight neck (diameter 0.17-0.2, length 0.35) + lip and cork cylinder (0.21 x 0.15); total 1.2 [SEEN 8.6: bulb 40 px, cork top 51 px above the bulb centre; 7.4: the bulb is half of a lying flask]; emissive light blue with a darker inner swirl sphere and a bright rim. 2-3 flasks in a stack may render paler [SEEN 43-44].

**Cauldron**: lower hemisphere radius 1.7 squashed to depth 1.4 (bottom 0.3 above ground), double-sided (outside #3d2e3b, inside grey with a bright centre patch and a faint vertical seam); torus rim (tube 0.09) with a thin light edge; 2 small torus lugs on the rim; 6 logs (boxes 1.1 x 0.45 x 0.45) laid radially at radius 1.5-2.0; fire = 40-60 thin curved orange strands (additive billboards or thin cones, 0.3-0.6 high) between the logs plus a few sparks; liquid = emissive disc whose radius and height follow section 2.6, with soft white foam blotches.

**Villager** (2.0 m upright, 1.7 m hunched, shoulders 0.9 wide): stocky rounded-box/capsule torso (radius 0.38, height 0.8), sphere head radius 0.2 with a brown hair cap (painted comb strokes), two thick arms, two short box legs. Sick: body pitched 35 deg forward, both hands on the head, yellow-green skin, blue shirt with a pale patch on the back. In the pot: chest-deep, arms on the rim. Bathed: white shirt, grey-blue vest, grey trousers, healthy skin, hunched clutching the stomach, red glow sprite (0.5 m) on the lower back. Healed: upright, one fist raised when cheering. The crowd is one InstancedMesh.

**Nurse** (1.7 m): cone-frustum skirt (bottom radius 0.38, dark maroon-brown), small pale torso with white apron, sphere head, crimson bob (half sphere), small white cap. Syringe: barrel cylinder length 1.2, diameter 0.2, transparent with an inner green cylinder scaled by fill; grey plunger disc and dark T-handle on top; thin needle cone 0.3 at the bottom.

**Usher** (1.7 m): same body; dusty pink hair, white headband, grey-lilac blouse with puffed sleeves, white apron, charcoal skirt; one arm horizontal.

**Rat** (0.6 m long, 0.25 wide): stretched sphere body, 2 tiny white cones (ears), thin cylinder tail 0.5 long; InstancedMesh.

**Drill**: 2 spoked wheels diameter 1.1; octagonal steel housing 0.9; cone drill length 1.4, base diameter 0.9, made of 4-5 stacked frustums with a spiral groove; rear V-shaped handle of two bars 1.9 long ending in a T crossbar; total length about 4.

**Bed** (2.7 x 1.7): frame box, mattress top at 0.55, 4 square posts 0.14 thick (foot 0.6 high, head 1.0 high), flat headboard plank, dusty-rose blanket over 80 % of the length with one diagonal fold line, cream pillow at the head (+x end).

**Pallet**: dark frame 1.6 x 0.15 x 1.3, recessed plank top, 4 small corner brackets.

**Coin**: cylinder diameter 0.55, thickness 0.09, orange, lighter rim, embossed ring and swirl glyph on the faces.

**Walls / posts / fences**: boxes as in 4.4 with a recessed darker centre panel; post caps slightly wider and pinkish-grey. Pen pickets: boxes 0.22 wide, 0.9-1.05 high (uneven), pointed light-cut tops, 0.26 pitch along the arc. Iron fence: 5-7 dark uneven planks 1.2 high. South gate: two dark wooden leaves, each with a V/chevron brace and a round knob, closing to a low arch. North double door: two dark panelled leaves with round pale knobs, gently arched top.

**Scenery**: boulders = irregular 5-8-facet convex blobs 1.5-2.5 m (cliff blocks 3-6 m, darker); conifers = 3 stacked cones with ragged lower edges, no trunk, 2-3.5 m tall, base 1.5-2 m; crates = 1.1 m dark cubes with framed faces and cobweb strands; dry reed tufts; side table 0.8 x 0.55 x 0.8 with a pale basin and a blue-white cloth.

---

## 8. UI

### 8.1 HUD (screen space; reference frame 608 x 1080, scale with viewport width)

[SEEN, identical in every gameplay frame; only the coin number changes]

| Element | Rect / position (px) | Look |
|---|---|---|
| Top bar | x 84-608, y 0-40 | dark slate #272f34, 90 % opaque |
| Portrait | x 3-83, y 3-83 | rounded square, periwinkle border (#c1c9dd / #7d86a9), blue background #4b60a4, plague-doctor bust (black hat, dark beak, green goggles) |
| Level number | x 55-92, y 60-84 | "32", heavy white digits with black outline, overlapping the portrait's lower-right corner |
| Cell 1 | icon (118, 20), text x 137-190 | gold wheat ear, "31/32" |
| Cell 2 | icon (248, 20) | cut log, "4.6M" |
| Cell 3 | icon (375, 20) | green sprig, "28.3M" |
| Dividers | x 210, 343, 476 | thin vertical lines #555557, 24 px tall |
| Coin cell | icon (511, 20) radius 12, digits x 530-596, y 8-32 | copper-red coin with swirl emboss; digits larger (cap height 22 px vs 15 px) and wide-spaced |
| Power pill | x 88-268, y 45-80 | dark rounded rectangle #23272a, gold shield with crossed swords at (118, 62), "3,105,998" |

Font: heavy rounded display sans, white with dark outline and drop shadow ("Lilita One" is a close free match).

Coin counter behaviour: digits simply change, no pop or scale [SEEN]; it rolls linearly during pickups, payments and the rat reward (rates in sections 2.8-2.10).

The other HUD values belong to the surrounding strategy game and never change in the ad. [EXTENDED] Recommended live bindings: level number = 1 + unlocks bought; cell 1 = `discharged/TOTAL` (person icon); cell 2 = flasks carried (flask icon); cell 3 = potion in the cauldron "n/10"; power pill = total gold earned.

No joystick graphic, health bars, floating numbers or text pop-ups exist [SEEN].

### 8.2 World-space decals (flat on the ground, y = 0.02, unlit)

- **Doctor ring**: dashed circle diameter 1.6 m, 18 rounded dashes, stroke 0.06 m, #b9f567 with a soft glow; dashes do not rotate [SEEN 19.72-19.85].
- **Capacity label**: rounded rectangle 2.1 x 0.9 m with a dashed pale outline (#cfcbcb, 60 %), interior slightly darker than the floor; white person-bust icon then "0/2" (digits spaced "0 / 2") in the HUD font, white with dark outline, baseline along +x. Full state: solid #24ee34 fill, "2/2" [SEEN 13.57-14.50, 31.30-32.20, 45.37-46.33].
- **Price pad**: four white arc brackets (each 50 deg, rounded caps, 75 % opaque, #d0c5c1) of a circle 1.9 m across; white icon in the centre; copper coin icon + price in the HUD font at the edge. Paying state: solid green rectangle 2.0 x 1.5 m under icon and text. Icons: nurse bust (A, B), bulldozer (C), house with cross and up-arrow (D).
- **Dashed circle at the drill**: radius 2.8 m, about 24 long dashes, pale orange-yellow, small white sparkles inside [SEEN 24.2-26.6].
- **Bed outlines**: thin yellow rectangles around newly unlocked beds, fading within 0.1 s after the glow [SEEN 51.5].

### 8.3 Bubbles (camera-facing sprites; white circle with a small tail at the bottom)

| Bubble | Size / place | Content | When |
|---|---|---|---|
| Potion request | diameter 1.2 m, 3.3 m above the rim centre | blue round flask with orange cork on a terracotta disc, cream ring, red glowing outline, wobbling red "!" tick at the upper right | section 2.6 [SEEN 8.2-9.23, 32.57-33.3] |
| Cure progress | diameter 1.2 m, same place; also above a bed head during treatment | white plus on terracotta; green clockwise pie from 12 o'clock; then white check on green | [SEEN 13.33-14.43, 21.63-23.30, 31.10-32.13, 45.27-46.33] |
| Needs nurse | diameter 1.2 m, 1.8 m above the bed head | nurse bust (brown hair, white cap with dark cross), small plus at the lower right, cream fill, dark red outline with red glow, red tick | [SEEN 16.43-21.63] |
| Sick emoji | diameter 0.9 m, 0.5 m above the head | green nauseated face: X eyes, open mouth, red tongue, sweat drop; thin dark outline | released villagers until they jump [SEEN 12.33-13.27, 29.93 on] |
| Scared emoji | diameter 0.9 m, above the doctor | blue forehead fading to yellow, wide eyes, open mouth, hands on cheeks | [SEEN 1.90-2.80] |
| Happy emoji | diameter 0.9 m, above the cart driver | orange grinning face, closed eyes, blush | [SEEN 39.17-39.87] |

Pop-in: scale 0 -> 1 in 3-5 frames (emoji with a slight overshoot to 1.1); pop-out: scale to 0 in 2-5 frames.

### 8.4 Guide arrow

Extruded 3D arrow pointing down, 0.75 m wide, 0.9 m tall, 0.3 m thick, face #5aff2e, lighter top bevel, dark green outline. Bobs sinusoidally +-0.4 m with a 0.9 s period [SEEN f483 -> f510] and spins about the vertical axis at about 120 deg/s (seen edge-on and face-on alternately).

---

## 9. VFX, animation and feel

| # | Effect | Numbers | Evidence |
|---|---|---|---|
| 1 | Ploughing | no particles; balls pile 2-3 deep on the blade, spill round the tips; bare wake refills in 0.5-1 s | 0.9-1.6, 3.8-4.5, 37.5-40.9 |
| 2 | Bubble capture | 15-25 balls thrown 0.8-1.3 m up and outward for 0.27 s; bubble semi-transparent smear for 3 frames while it snaps in; doctor pivots up to 150 deg in 5 frames | 3.77-4.07 |
| 3 | Oversize hit | camera shake +-0.08 m for 4 frames; doctor shoved; scared emoji | 1.40-2.80 |
| 4 | Crack, shell, shards | section 2.4 timeline; shards 0.3-1.1 m | 5.57-6.9, 41.07-41.9 |
| 5 | Grinding | fine cyan/white specks spray up along both roller rows; chips linger 0.5-0.9 s | 6.4-7.5, 41.9-43.3 |
| 6 | Flask ejection | small pale flash at the tray edge per flask; hop, tumble, settle in 0.15-0.2 s | 6.53-6.97 |
| 7 | Flask pickup | flask stretches into a blue streak (2-4 frames) and pops onto the stack top | 7.63-8.00 |
| 8 | Stack sway | bends back 35-40 deg at speed, pitch stretches up to 30 % (0.76 -> about 1.0 m, necks become visible between the bulbs), straightens in 0.10-0.15 s and settles back to the rest pitch within 0.2 s | 8.1-9.5, 43.1-44.2 |
| 9 | Pour | white flash at launch; arc 0.3 s; plume 0.9-1.5 m high per impact (0.15 s); surface over-brightens to near white; spiky white-cyan splash sprites around the rim for 0.5 s after the last flask; wisps and sparkles 0.4 s more | 9.63-11.0, 44.1-45.1 |
| 10 | Gate | dust puff at the hinge, swing 0.25 s, no bounce | 11.97-12.2 |
| 11 | Miasma | soft translucent green puffs, slow drift, over the crowd and around every sick walker; grey dust puffs at running feet | continuous |
| 12 | Bath entry | parabolic hop 0.2 s with a green puff trail; white-cyan burst on landing 0.15-0.3 s | 13.30-13.53, 31.13-31.45 |
| 13 | Cure | 12-30 bright green chunks burst 1 m up from the bathers, fall and float on the surface, fading over 0.6-0.7 s; cyan/white sparkles; skin colour swap | 13.8-14.4, 31.4-32.1 |
| 14 | Label flip | instant, 1 frame | 13.57 |
| 15 | Coin fountain | glowing yellow coins with dark outline, rope 2.6-3 m tall, 1.0 s; coins fade in on the pallet | 14.63-15.73 |
| 16 | Coin pickup | rainbow-shaped chain, apex 0.8 m above the hat; last pallet coins fade as ghosts; column grows bottom-up, slightly S-curved while growing | 18.33-19.0 |
| 17 | Pad pay | bending rope of coins, 2 discs per frame; green wipe | 19.77-20.23 |
| 18 | Unlock burst, characters | 1-2 frames of pink/red sparks; pillar of fiery golden light 2.5 m wide, 5-6 m tall (near-white core, golden body, red-orange fringe), vertical streaks, bloom lighting 6 m around; peak at 0.15 s, gone by 0.45-0.5 s; 3-5 white outlined up-arrow glyphs rise 2 m and linger 0.2 s; characters appear inside it 0.2 s in and run out | 20.27-20.8, 28.73-29.25 |
| 19 | Unlock burst, objects | bright yellow rounded-rectangle outline around the footprint (1.3 x footprint) with a translucent golden curtain rising 2-3 m, fine vertical streaks and sparkles; full 0.33-0.37 s, thin outline lingers 2-3 frames; round a tool (cart, hand scoop) the footprint is a block of gold dense enough to half-hide it for the first 0.22 s, thinned to the outline by 0.34 s [SEEN 36.3-36.5: about half of the box is bright gold]; object pops in with a small scale overshoot (0.1 s). Ward 2: old props vanish first, then one frame of empty yard, then every bed gets its own rectangle | 36.23-36.60, 51.00-51.57 |
| 20 | Injection | syringe swing in 3 frames; green splash 0.2 s; patient green tint and outline 0.65 s | 21.87-22.7 |
| 21 | Healed burst | golden glow, 2-3 thin expanding gold rings to 3 m, streaks, sparkles, up-arrow glyphs; 0.4 s | 22.93-23.30 |
| 22 | Red wounded glow | soft round sprite 0.5 m, pulsing (fades in and out about once per second) | 14.6-22.7 |
| 23 | Rat kill | crimson silhouette 3-5 frames, then gone; orange sparks, dark red puffs | 24.63-25.6 |
| 24 | Rat coin heap and ribbons | section 2.10 | 24.77-26.6 |
| 25 | Run dust | pale translucent arc 0.8 m behind the hem on start or sharp turn, 6 frames | 11.1 |
| 26 | Fire | flames and sparks flicker continuously | continuous |
| 27 | Crowd idle | bob/sway, rising green blobs | continuous |
| 28 | Rat idle | jitter in place, scurry; the red-eyed runner leaves a short smear | 16.0-18.8 |

**Camera shake** (dynamics, block matching): amplitude 2-7 px (0.04-0.12 m), 4-10 frames each: oversize bubble hit (1.40-1.57); grinder crush (5.63-6.0, 41.0-41.7, 3-frame period); bathers landing in the pot (13.57-13.77, 31.23-31.5, 45.4-45.67, 46.97-47.2); character unlock bursts (20.30-20.47, 28.63-28.9; 5-7 px); continuous 2-4 px jitter during the drill sortie (24.9-26.5).

**Feel notes**: no squash and stretch on characters; no damage numbers; all pops are quick scale tweens; every transfer of items is a visible stream of individual objects, never an instant teleport.

---

## 10. Audio (measured in the ad's sound track where marked, otherwise inferred)

The ad's sound track is a voice-over and music with the game's effects underneath. A row marked [SEEN t] was measured there (spectra and onset times, t in seconds of the sound track); the other rows could not be told apart from the voice and are inferred.

Sound events worth synthesising with WebAudio:

| Event | Suggested sound |
|---|---|
| River ambience | soft continuous marble/bead rattle, louder near the river [SEEN 0.9-3.4: level from 4 to 9 kHz] |
| Ploughing | denser bead rattle scaled by speed |
| Bubble capture | wet "bloop" + short bead scatter |
| Oversize hit | low rubbery thud + short alarm chirp (scared emoji) |
| Happy emoji | two-note rising chime |
| Bubble on grinder | glass crack (noise burst + high ping), then a grinding rumble with crunches [SEEN 5.5-7.1, 40.9-42.8: a hiss that is level from 3 to 10 kHz, from the moment the bubble rests] |
| Flask ejected | a soft pop per flask; as they land, one glass "ting" at a fixed pitch (3.23 and 2.53 kHz) about four times a second [SEEN 6.8-7.6, 41.5-42.5] |
| Flask pickup | rising pops, pitch climbing with stack height [SEEN 7.8-8.2: one every 0.09 s, each sweeping up a little over an octave in 60 ms, into 0.7 kHz for the first flask and 1.1 kHz for the fifth] |
| Flask pour | "plop" + fizz per flask; sustained bubbling while potion > 0 |
| Fire | low crackle loop |
| Gate | wooden creak + thud |
| Bath hop-in / hop-out | splash |
| Cure progress and check | rising shimmer, then a two-step "ding", the loudest effect of the ad: a short low note (678 Hz) and 60 ms later one two octaves higher that rings 0.5 s [SEEN 14.4, 32.4, 46.2, 48.1] |
| Coin fountain | soft coin jingle while the rope is in the air |
| Coin landing on pallet | bright shower of clinks, most of it between 9 and 10 kHz [SEEN 14.9-15.8] |
| Coin pickup | one tick per coin, 13-45 ms apart, always at the same pitch (partials at 4.25, 5.67, 7.25, 9.67 and 12.4 kHz) [SEEN 18.3-19.1, 33.9-34.6, 48.9-49.7] |
| Pad payment | the same ticks at the same pitch [SEEN 19.8-20.3, 27.7-28.2, 35.6-36.2, 50.6-51.1], then a confirm chord |
| Unlock burst | a click, a wash of noise that dies away in 1.5 s, a swell on D6 over G5 and a tree of chimes (2.3-4.1 kHz and 7-11 kHz) struck one after another [SEEN 20.3-21.9, 28.5-30.1] |
| Nurse injection | a bright rising "zip" (640 Hz up an octave in 70 ms) [SEEN 21.9] + squirt; healed = a bright chord between 1.7 and 6 kHz that swells in 0.1 s, holds 0.5 s and starts as the pie closes, 0.2 s before the check mark [SEEN 22.7-23.3] |
| Villager cheer | short voice-like "hey" (filtered noise + formant) |
| Drill | motor whine rising, squeaks, crunches; a hiss falling from 7.5 to 5 kHz while the coins fly [SEEN 24.65-25.75] |
| Rat coins to HUD | big coins clinking five or six times a second (partials near 5.7, 9.5 and 12 kHz) from the heap until the flight ends; no counter ticks [SEEN 25.0-26.5] |
| Guide arrow appears | soft "pip" |
| Footsteps | muffled cloth steps, tempo by speed; cart = wooden wheel rumble |
| Win | long fanfare |

---

## 11. Parameter table

| Name | Value | Unit | Tag |
|---|---|---|---|
| RING_DIAMETER | 1.6 | m | SEEN |
| DOCTOR_HEIGHT | 1.9 (2.15 with feather) | m | SEEN |
| PLAYER_RADIUS | 0.4 | m | inferred |
| PLAYER_SPEED | 7.0 | m/s | SEEN (4.8-8.3; bursts to 10-17 ignored) |
| PLAYER_ACCEL / DECEL | 45 / 60 | m/s2 | SEEN (0.2-0.3 s ramps) |
| SCOOP_TURN_RATE | 400 | deg/s | SEEN |
| CART_SPEED | 5.0 | m/s | SEEN |
| CART_ACCEL | 12 | m/s2 | inferred |
| CART_TURN_RATE | 130 | deg/s | SEEN |
| CART_MOUNT_TIME / DISMOUNT_TIME | 0.3 / 0.15 | s | SEEN |
| SCOOP_CHORD / SAGITTA / HEIGHT | 2.6 / 0.7 / 0.9 | m | SEEN |
| SCOOP_OFFSET (blade centre ahead of doctor) | 1.15 | m | SEEN |
| SCOOP_MAX_BUBBLE | 2.8 | m | SEEN (2.6 yes, 3.6 no) |
| CART_BLADE_CHORD / SAGITTA / HEIGHT | 4.4 / 1.1 / 1.1 | m | SEEN |
| CART_MAX_BUBBLE | 4.2 | m | inferred |
| TOOL_GRAB_RADIUS (scoop / cart) | 1.1 / 1.2 | m | inferred |
| TOOL_REARM_DISTANCE (scoop / cart) | 2.0 / 2.5 | m | EXTENDED |
| WORK_AREA_MIN_X | 8.2 | m | EXTENDED |
| PUSHED_DURATION / PUSH_SPEED | 0.8 / 4 | s, m/s | SEEN |
| BALL_COUNT | 3200 | - | SEEN (1,100-1,900 on screen) |
| BALL_DIAMETER | 0.24 | m | SEEN |
| FLOW_SPEED_BANK / MID | 0.9 / 3.2 | m/s | SEEN |
| FLOW_DOWNSTREAM_GAIN | 0.5 | - | SEEN |
| RIVER_HALF_WIDTH | 3.2 -> 3.8 | m | SEEN |
| WAKE_REFILL_TIME | 0.5-1.0 | s | SEEN |
| MAX_STRAYS / STRAY_LIFETIME | 60 / 30 | -, s | SEEN / EXTENDED |
| BUBBLE_DIAMETERS (S, M, L) | 2.0, 2.6, 3.6 | m | SEEN |
| BUBBLE_MIX (S, M, L) | 35, 35, 30 | % | inferred |
| BUBBLE_SPAWN_INTERVAL | uniform 0.4-2.9 (mean 1.5) | s | SEEN |
| BUBBLE_SPEED | 4.5 | m/s | SEEN (3.3-8.3) |
| BUBBLE_MAX_ALIVE | 6 | - | EXTENDED |
| DOCK_SNAP_TIME | 0.1 | s | SEEN |
| GRINDER_SIZE | 2.3 x 5.1 | m | SEEN |
| GRINDER_ACCEPT_MARGIN | 0.5 | m | inferred |
| GRIND_CRACK / SHELL / SHARDS / FREE | 0.20 / 0.35 / 0.50 / 1.30 | s after rest | SEEN |
| FLASK_EJECT_START / INTERVAL | 0.6 / 0.04 | s | SEEN (0.47-1.2 / 0.04) |
| FLASK_YIELD (S, M, L) | 3, 5, 9 | units | inferred, SEEN, SEEN |
| GROUND_MESHES_PER_UNIT | 2 | - | SEEN |
| FLASK_PICKUP_RADIUS | 1.6 | m | SEEN |
| FLASK_PICKUP_RATE | 14 | units/s | SEEN |
| FLASK_CARRY_MAX | 12 | units | EXTENDED |
| FLASK_STACK_PITCH (at rest / stretched while running) | 0.76 / 1.0 | m | SEEN (9.5, 44.2 / 44.0) |
| FLASK_SIZE (bulb / total) | 0.65 / 1.2 | m | SEEN |
| DEPOSIT_RADIUS | 4.5 | m | SEEN (3.4-4.3) |
| DEPOSIT_DELAY / INTERVAL / FLIGHT | 0.25 / 0.08 / 0.3 | s | SEEN |
| CAULDRON_RIM_DIAMETER / RIM_HEIGHT | 3.4 / 1.7 | m | SEEN |
| CAULDRON_COLLIDER_RADIUS | 2.15 | m | SEEN |
| POTION_CAPACITY | 10 | units | inferred |
| POTION_PER_BATHER | 1 | unit | inferred |
| BATH_SLOTS | 2 | - | SEEN |
| BATH_PRE_HOP_WAIT / HOP_IN / CURE / CHECK / HOP_OUT | 0.2 / 0.2 / 0.5 / 0.25 / 0.17 | s | SEEN |
| BATH_PERIOD_WITH_QUEUE | 1.53 | s | SEEN |
| QUEUE_MAX | 4 | - | SEEN |
| QUEUE_PITCH | 1.0 | m | SEEN |
| USHER_RELEASE_INTERVAL | 0.25 | s | SEEN |
| MANUAL_RELEASE_RADIUS / COUNT / DELAY | 3.0 / 2 / 0.1 | m, -, s | SEEN |
| GATE_SWING_TIME | 0.25 | s | SEEN |
| SICK_WALK_SPEED | 5.5 | m/s | SEEN |
| BATHED_WALK_SPEED | 4.5 | m/s | SEEN |
| HEALED_RUN_SPEED | 8 | m/s | SEEN |
| NURSE_RUN_SPEED | 6.5 | m/s | SEEN |
| BATH_FEE | 25 | gold | SEEN |
| FIRST_BATCH_MULTIPLIER | 2 | - | SEEN |
| GOLD_PER_COIN_MESH | 2 | gold | SEEN |
| FOUNTAIN_DURATION / COIN_FLIGHT | 1.0 / 0.4 | s | SEEN |
| PALLET_PICKUP_RADIUS | 1.9 | m | SEEN |
| PICKUP_RATE | 100 | gold/s | SEEN |
| COIN_SIZE (diameter / thickness) | 0.55 / 0.09 | m | SEEN |
| BACK_COLUMN_MAX_DISCS | 70 | - | SEEN (63-72) |
| PAD_PAY_RADIUS | 2.4 | m | SEEN (1.8-2.6) |
| PAD_PAY_MAX_SPEED / DWELL | 0.5 / 0.1 | m/s, s | inferred |
| PAD_PAY_DURATION | clamp(price/135, 0.5, 0.9) | s | SEEN |
| PAD_DIAMETER / GREEN_RECT | 1.9 / 2.0 x 1.5 | m | SEEN |
| PRICES A, B, C, D | 50, 50, 50, 100 | gold | SEEN |
| PRICES E, F, G, H, I | 250, 400, 600, 800, 1500 | gold | EXTENDED |
| BED_SIZE | 2.7 x 1.7 | m | SEEN |
| BEDS_WARD1 / BEDS_WARD2 | 4 / 6 | - | SEEN |
| NURSE_START_DELAY (patient lying before treatment starts) | 3.0 | s | inferred (SEEN at least 1.1; probably at least 1.9 and at most about 11) |
| TREATMENT_TIME (to healed) | 1.4 | s | SEEN |
| TREATMENT_PIE_TIME | 0.37 | s | SEEN |
| CHEER_TIME / HOP_OFF_TIME | 0.35 / 0.2 | s | SEEN |
| DRILL_CREW | 2 | - | SEEN |
| DRILL_PUSH_DISTANCE / TIME | 5.5 / 0.9 | m, s | SEEN |
| DRILL_COIN_FOUNTAIN / FLY_TO_HUD | 0.6 / 0.5 | s | SEEN |
| DRILL_REWARD | 250 | gold | SEEN |
| RAT_COUNT_VISIBLE | 150 | - | SEEN (100-150) |
| RATS_KILLED_PER_SORTIE | 60 | - | inferred |
| RAT_REGROW | 20 | s | EXTENDED |
| DRILL_LONE_WAIT | 8 | s | EXTENDED |
| RAT_CREEP_SPEED | 2 | m/s | SEEN |
| DASHED_CIRCLE_RADIUS | 2.8 | m | SEEN (1.9-3) |
| TOTAL_VILLAGERS | 180 | - | EXTENDED |
| CROWD_PITCH | 1.0 | m | SEEN |
| ARROW_HOVER / BOB / PERIOD / SPIN | 2.8 / +-0.4 / 0.9 / 120 | m, m, s, deg/s | SEEN |
| BUBBLE_UI_SIZE (station / character) | 1.2 / 0.9 | m | SEEN |
| UI_POP_IN / POP_OUT | 0.13 / 0.1 | s | SEEN |
| UNLOCK_PILLAR_TIME / OBJECT_GLOW_TIME | 0.45 / 0.37 | s | SEEN |
| CAMERA_OFFSET | (-13.1, 17.2, 15.8) | m | SEEN (ring width, median of 13 frames) |
| CAMERA_FOV_VERTICAL | 38 | deg | SEEN (35 +-5) |
| CAMERA_PITCH | 40 | deg | SEEN |
| CAMERA_TARGET_BIAS | (1.2, 0, -0.7) | m | SEEN |
| CAMERA_SMOOTH_TIME | 0.2 | s | SEEN |
| CAMERA_STATION_BLEND | 0.6 | - | SEEN (pads, pallet, pen; cauldron 0.7, grinder 0.35-0.6: section 5) |
| CAMERA_ZOOM_OPENING | 1.16 | - | SEEN 0.2-6.4 |
| CAMERA_ZOOM_LATE | 1.12 | - | EXTENDED (from ward 2 on) |
| CAMERA_SHAKE_AMPLITUDE | 0.04-0.12 | m | SEEN |
| LANTERN_RANGE / FIRE_RANGE / POTION_RANGE | 9 / 7 / 5 | m | SEEN / inferred |
| TILE_SIZE | 0.85 | m | SEEN (0.6-1.0) |
| WALL_HEIGHT / THICKNESS / POST | 2.0 / 0.35 / 0.6 x 2.3 | m | SEEN |
| GAME_SPEED (global multiplier on all NPC and effect timings) | 1.0 | - | EXTENDED |

---

## 12. Uncertainties and the assumption chosen

1. **True game speed.** Everything in the ad is very fast (0.5 s cures, 7 m/s doctor, bursts of 10-17 m/s after 27 s). The ad may be sped up or show an upgraded character. Assumption: use the measured values; expose `GAME_SPEED` and `PLAYER_SPEED`.
2. **Coin accounting.** Pallet coins, back-column discs and the HUD do not share one ratio (25 pallet coins gave +100 once and +50 once; both times the back column grew to about 50 discs; the cart pad consumed that full column with no HUD change; the column after the last pickup, worth +100 from two batches, is again only 50-58 discs, so the real game may cap the visible column near 55 discs). Assumption: wallet arithmetic is exact (25 per patient, first batch doubled, prices subtracted); coin meshes and discs are cosmetic.
3. **Why the bath stopped at 47.9 s.** Assumption: free-bed reservation. Alternatives: a hidden potion budget or queue pacing.
4. **Sick villager entering ward 2.** At 53.1-53.2 s, behind the outro wipe, a villager with a green sick bubble stands at the left-most new bed, and a second red-haired attendant stands at ward 2's south-west corner from 51.2 s. Ward 2 may take patients straight from the crowd. Assumption: ward 2 is simply 6 more beds for bathed patients.
5. **Drill event.** Shown once. Whether it repeats, what it pays later, what the rats or the dashed circle otherwise do, and where the crew goes are unknown. Assumption: repeatable, 250 gold, 20 s regrow, crew goes home.
6. **Potion-request bubble rule.** Shown with an empty pot while the doctor approached with flasks (8.2-9.2) and right after a batch (32.6-33.3), but not at 42.8-44.0 with 1 unit left and the doctor approaching with 9 flasks. Assumption (fits all three): visible while potion < 2, no deposit is running, and the doctor carries no flasks or the pot is empty. A timed or first-time-only tutorial bubble would fit equally well.
7. **Does the doctor have to be near** the cauldron for a batch, or near the pen for the first release? Assumption: not for the bath; yes for the release until the usher exists.
8. **Tool pickup and drop.** A re-grab of the parked scoop, and mounting/dismounting choices, are never clearly player-driven. Assumption: proximity with re-arming; park on delivery or at the work-area edge.
9. **Capture rule.** Only two data points (2.6 m caught, 3.6 m rejected) for the hand scoop. Assumption: diameter threshold 2.8 m, head-on contact with the concave face.
10. **Flask yield and the 2:1 pile-to-stack ratio.** Counted on smeared frames (10-11 vs 5; 18-20 vs 9). Assumption: 2 meshes per unit; S yield 3 is a guess.
11. **Potion capacity and use.** Capacity 10 and 1 unit per bather fit six liquid-width measurements but are not shown directly.
12. **Pad triggers.** Only pad A's and pad C's appearance are on screen. B and D triggers are guesses.
13. **Carry limits.** None was reached (9 flasks, 100 gold). Assumption: 12 flasks, unlimited gold.
14. **Paying with fewer carried discs than the price**, paying while moving, and partial payment were not shown. Assumption: pays from the wallet, needs a 0.1 s near-stop, progress is kept.
15. **Nurse count rule.** 4 nurses for 4 beds; unknown whether it is "one per bed" or a fixed 4. Assumption: one per ward-1 bed.
16. **Camera.** Pitch +-2.5 deg, FOV +-5 deg, follow rule (dead zone vs look-ahead) inferred; scripted pans may be ad editing rather than game behaviour.
17. **River geometry and flow.** Source, total length and exact speed profile are off-screen or imprecise; bubble speed estimates range from 3.3 to 14 m/s. Assumption: values in section 11.
18. **Layout far from the courtyard.** Yard depth, ward-1's south-west part, door position, drill position (+-2 m), crowd extent, east bank.
19. **Interior walkability.** The doctor never enters between the beds, the yard or ward 2. Assumption: walkable.
20. **Grinder disc rotation, cart gear rotation, ring dash rotation**: not resolvable; assumed slow idle spin, rotating gears, static ring.
21. **Audio**: measured in the ad's sound track only where an effect stands clear of the voice-over and the music (the rows marked [SEEN] in section 10); the rest of section 10 is inferred.
22. **Everything tagged [EXTENDED]**: total crowd size, win condition, helpers E-I and their prices, regrow timer, HUD bindings.
23. **Nurse start delay.** Only bounds are available (at least 1.1 s directly visible; about 1.9 s and about 11 s as inferred lower and upper bounds after the patient lies down). Whether it is a fixed rest time, a nurse cooldown or something else is unknown. Assumption: 3.0 s after lying down, per bed.
24. **What later healed patients do.** After the first sortie no healed patient is ever on screen again (the batch-2 pair is healed off-camera; the HUD shows no second +250 up to 52.6 s). Assumption: they leave by the south gate and only crew the drill when the swarm has regrown.

---

## Review log

Adversarial review pass: the footage was re-watched independently (all 5 fps frames in montage, 30 fps extracts for the second pour and the ward-2 unlock, pixel scans of the coin column, HUD digit strips) before reading this spec. Crops are in `work/review/`. Times are video seconds.

### Changes made

| # | Section(s) | Change | Evidence |
|---|---|---|---|
| 1 | 0.2, 1.2, 2.10, 11, 12 | Nurses do not treat a patient the moment he lies down. Added `NURSE_START_DELAY` = 3.0 s (inferred; directly visible lower bound 1.1 s, inferred bounds 1.9-11 s); treatment timeline now starts at max(lie-down + delay, nurse arrival). | Bed A: patient lying from 33.5, still red-glowing with the nurse idle (syringe upright, no bubble) at 34.0, 34.4 and 34.6. Bed A again: a patient lying untreated at 48.6, 48.8, 49.0, 49.2, 49.4, 49.6 (the bed is out of frame before 48.6; batch 3 left the pot at 46.4). Bed B is empty from 45.0 to 48.6 and batch 4's pair walks to B and D at 48.6-49.6, so batch 3 must have taken A and C, which means the batch-2 pair had been treated and had left (inferred, not on screen). The first pair had lain 4.5-5 s before the nurses arrived at 21.2-21.4 and got the plus bubble at 21.8. |
| 2 | 0.2, 2.6, 12 | Potion-request bubble rule changed from "potion < 2" to "potion < 2 and (no flasks carried or pot empty)". The first draft's own rule contradicted a sighting it listed. | Bubble present at 8.6 and 9.0 (empty pot, doctor carrying 5) and at 32.6-33.0 (1 unit, nothing carried); absent at 43.2, 43.4 and 43.6 (1 unit, four villagers waiting, doctor still 5-7 m away carrying 9, cauldron and the space above it fully in frame; the pot is only partly in frame at 42.8-43.0). |
| 3 | 4.3 | Pad B: position kept at (-4.2, -1.9) on the tiles; only a note on its distance to the sand edge was added. (A move onto the bay sand was tried during this review and reverted after a 2x crop.) | 27.6 and 28.6 at 2x zoom: tile grout lines on all sides of the pad; the smooth sand bay begins at a straight curb line just beyond the pad's west bracket. Absent at 12.0-12.4. |
| 4 | 2.10, 11 | Drill crew rule rewritten: a healed patient crews the drill only if the swarm is ready when he leaves his bed; nobody waits for the regrow; a lone crew member sorties alone after `DRILL_LONE_WAIT` = 8 s. | (a) Fidelity: with the first draft's "wait at the handle" rule the batch-2 pair would sortie at 46.6 and pay +250 at about 48.5, but the HUD reads 300 at 48.2, 48.4, 48.6 and then rises smoothly to 400 by 49.8 (pallet pickup only). (b) Completability: an odd last patient waiting for a partner would block `discharged == TOTAL_VILLAGERS` forever. |
| 5 | 2.12 | Big cauldron: stated that all bath/release thresholds scale with `BATH_SLOTS`, plus a partial-batch rule so a 4-slot bath cannot stall on beds. | [EXTENDED] coherence; no footage. |
| 6 | 2.8, 12 | Back-column evidence corrected. The "tallest 63-72 discs" figure was replaced by measured values, and the two sightings the formula does not reproduce are now stated. | Pixel scan of the orange column: 229-245 px at 19.2-19.6 (about 50 discs); 130 px at 20.8-24.0 (about 28); none at 28.4; 279-288 px at 34.6-35.2 with the ring 12 % larger (about 50 discs after a +50 pickup); none at 36.2 after pad C; 293-304 px at 49.8-50.2 (50-58 discs). |
| 7 | 2.5, 9, 11 | Flask stack pitch corrected from 0.95 m to 0.76 m at rest (stretching to about 1.0 m while running), so a 5-stack is 4.1 m instead of 4.85 m and a 9-stack 7.1 m instead of 8.65 m. | 9.5 s (30 fps frame, 2x crop with ruler): five upright bulbs with centres at y = 312, 350, 387, 425, 465 (38 px apart), cork top at y = 268, lowest bulb bottom at y = 478: 210 px, against 97 px from the doctor's hat crown to his feet. 44.2 s: 40 px apart. 44.0 s (stopping frame): 50 px apart. |

### Checked and left unchanged

- Wallet trace 0 -> 100 -> 50 -> 300 -> 250 -> 300 -> (300 through pad C) -> 400 -> 300: confirmed digit by digit at 17.8-20.8, 25.6-26.6, 33.4-36.8, 48.2-51.6. The HUD really does not move while pad C is paid (300 in every frame 34.4-36.8).
- World orientation (river east, yard north, ward-1 south, crowd west), grinder long axis north-south, flasks ejected on the west side, bed heads east, nurse posts on the south side near the head, pallet beside ward-1's north-east post: consistent in frames at 5.4, 8.6, 10.8, 16.4, 21.4, 24.4, 35.0, 42.2, 51.6.
- Bubble sizes: 3.6 m rejected at 1.4 (187 px against an 84 px ring), about 2.8 m caught at 5.4 (148 px, same 84 px ring), cart bubble 1.44 times the hand-caught one at 40.6; small bubble about 2.1 m at 2.2.
- Stack counts: 5 flasks at 8.0-9.4, 9 at 43.4-44.0; pour interval about 0.07-0.08 s at 44.1-44.6 (30 fps); one flask leaves the stack per launch, so the 2:1 pile-to-stack ratio is not a display artefact of the pour.
- Bath: "0/2" -> "2/2" at 13.6, 45.4, 47.0; cure about 0.5 s; batches 3 and 4 at 45.4-46.4 and 47.0-47.9; two villagers left queued at 47.8-48.4 while batch 4's patients walk to beds B and D.
- Usher unlock at 28.8-29.4, gate at the south end of the arc at 29.8-30.0, four in single file with emoji at 30.2-30.6.
- Drill: second man joins at 24.6, coin heap 25.0-25.8, ribbons 26.0-26.4, HUD 50 -> 133 -> 233 -> 300.
- Cart: appears on the hand scoop's spot at 36.2-36.6, doctor seated from 37.2, ring hidden, happy emoji 39.2-39.6, delivery at 41.0, cart left at the grinder afterwards.
- Ward 2: empty dirt yard with 7 rats at 51.0, 6 beds and 6 nurses at 51.6.

### Remaining doubts

- The back column and the HUD cannot both be modelled exactly (see item 6); the wallet arithmetic of this spec is kept and the column is cosmetic.
- Ward 2 may have its own intake from the crowd: a second red-haired attendant stands at its south-west corner post from 51.6, and a villager with a sick emoji is at the west beds at 52.97 behind the outro wipe. Section 12 item 4 keeps the simpler reading.
- The guide arrow over the first flask pile sits only about 1.5 m above the flasks at 7.4-7.8 (2.6-3.0 m is right for the pallet at 16.4); not changed.
- Pad D may straddle the tile edge and the yard dirt rather than lie fully on the tiles (50.2-50.4); position left as is (medium-high confidence in the original, about 0.5 m at stake).
- Flask counts on the ground (10-11 and 18-20) come from blurred frames; at 42.2 only 13-15 are countable because pickup has started.

