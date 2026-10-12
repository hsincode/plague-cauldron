// Single source of truth for every tunable number and for the world layout.
// Values come from docs/SPEC.md (section 11 parameter table, section 4 layout).
// Units: metres, seconds, radians unless a name says otherwise. World: +x east, +y up, +z south.

export type UnlockId = 'nurses' | 'usher' | 'cart' | 'ward2' | 'porter' | 'bursar' | 'bigCauldron' | 'drill2' | 'driver'
export type BubbleSize = 'S' | 'M' | 'L'
export type ToolKind = 'scoop' | 'cart'

const DEG = Math.PI / 180

export const P = {
  // --- player ---
  RING_DIAMETER: 1.6,
  DOCTOR_HEIGHT: 1.9,
  PLAYER_RADIUS: 0.4,
  PLAYER_SPEED: 7.0,
  PLAYER_ACCEL: 45,
  PLAYER_DECEL: 60,
  FOOT_TURN_RATE: 900 * DEG,
  SCOOP_TURN_RATE: 400 * DEG,
  CART_SPEED: 5.0,
  CART_ACCEL: 12,
  CART_TURN_RATE: 130 * DEG,
  CART_MOUNT_TIME: 0.3,
  CART_DISMOUNT_TIME: 0.15,
  PUSHED_DURATION: 0.8,
  PUSH_SPEED: 4,
  WORK_AREA_MIN_X: 8.2,

  // --- tools (blade geometry lives in world/tools.ts) ---
  SCOOP_CHORD: 2.6,
  SCOOP_SAGITTA: 0.7,
  SCOOP_HEIGHT: 0.9,
  SCOOP_OFFSET: 1.15, // blade centre ahead of the holder
  SCOOP_MAX_BUBBLE: 2.8, // diameter
  SCOOP_GRAB_RADIUS: 1.1,
  SCOOP_REARM_DISTANCE: 2.0,
  CART_CHORD: 4.4,
  CART_SAGITTA: 1.1,
  CART_HEIGHT: 1.1,
  CART_BLADE_OFFSET: 3.7, // blade centre ahead of the driver seat
  CART_BODY_OFFSET: 1.5, // body centre ahead of the driver seat
  CART_BODY_RADIUS: 1.3, // collision circle of the wagon body
  CART_MAX_BUBBLE: 4.2,
  CART_GRAB_RADIUS: 1.2,
  CART_REARM_DISTANCE: 2.5,
  BLADE_THICKNESS: 0.12,

  // --- river ---
  BALL_COUNT: 3200,
  BALL_DIAMETER: 0.24,
  FLOW_SPEED_BANK: 0.9,
  FLOW_SPEED_MID: 3.2,
  FLOW_DOWNSTREAM_GAIN: 0.5,
  FLOW_RELAX_TIME: 0.25,
  MAX_STRAYS: 60,
  STRAY_LIFETIME: 30,
  STRAY_REST_TIME: 0.5,
  BUBBLE_DIAMETER: { S: 2.0, M: 2.6, L: 3.6 } as Record<BubbleSize, number>,
  BUBBLE_MIX: { S: 0.35, M: 0.35, L: 0.3 } as Record<BubbleSize, number>,
  BUBBLE_SPAWN_MIN: 0.4,
  BUBBLE_SPAWN_MAX: 2.9,
  BUBBLE_SPEED: 4.5,
  BUBBLE_MAX_ALIVE: 6,
  DOCK_SNAP_TIME: 0.1,
  DOCK_SEAT: 0.85, // docked bubble centre = blade centre + forward * DOCK_SEAT * radius

  // --- grinder & flasks ---
  GRINDER_ACCEPT_MARGIN: 0.5,
  GRIND_SLIDE_TIME: 0.15,
  GRIND_CRACK: 0.2,
  GRIND_SHELL: 0.35,
  GRIND_SHARDS: 0.5,
  GRIND_FREE: 1.3,
  FLASK_EJECT_START: 0.6,
  FLASK_EJECT_INTERVAL: 0.04,
  FLASK_EJECT_FLIGHT: 0.18,
  FLASK_YIELD: { S: 3, M: 5, L: 9 } as Record<BubbleSize, number>, // carried units
  GROUND_MESHES_PER_UNIT: 2,
  FLASK_PICKUP_RADIUS: 1.6,
  FLASK_PICKUP_RATE: 14, // units per second
  FLASK_CARRY_MAX: 12,
  FLASK_STACK_PITCH: 0.76,
  FLASK_BULB: 0.65,
  FLASK_TOTAL: 1.2,

  // --- cauldron & bath ---
  DEPOSIT_RADIUS: 4.5,
  DEPOSIT_DELAY: 0.25,
  DEPOSIT_INTERVAL: 0.08,
  DEPOSIT_FLIGHT: 0.3,
  CAULDRON_RIM_DIAMETER: 3.4,
  CAULDRON_RIM_HEIGHT: 1.7,
  CAULDRON_COLLIDER_RADIUS: 2.15,
  POTION_CAPACITY: 10,
  POTION_CAPACITY_BIG: 20,
  POTION_PER_BATHER: 1,
  BATH_SLOTS: 2,
  BATH_SLOTS_BIG: 4,
  BATH_PRE_HOP_WAIT: 0.2,
  BATH_HOP_STAGGER: 2 / 30,
  BATH_HOP_IN: 0.2,
  BATH_CURE: 0.5,
  BATH_CHECK: 0.25,
  BATH_HOP_OUT: 0.17,
  BATH_PARTIAL_WAIT: 2.0,
  BATH_LAST_WAIT: 1.0,
  QUEUE_MAX: 4,
  QUEUE_MAX_BIG: 6,
  QUEUE_PITCH: 1.0,
  USHER_RELEASE_INTERVAL: 0.25,
  MANUAL_RELEASE_RADIUS: 3.0,
  MANUAL_RELEASE_DELAY: 0.1,
  GATE_SWING_TIME: 0.25,
  GATE_CLOSE_DELAY: 0.5,
  SICK_WALK_SPEED: 5.5,
  BATHED_WALK_SPEED: 4.5,
  HEALED_RUN_SPEED: 8,
  NURSE_RUN_SPEED: 6.5,
  USHER_RUN_SPEED: 6.5,
  TOTAL_VILLAGERS: 180,
  CROWD_PITCH: 1.0,

  // --- coins ---
  BATH_FEE: 25,
  FIRST_BATCH_MULTIPLIER: 2,
  GOLD_PER_COIN_MESH: 2,
  FOUNTAIN_DELAY: 0.1,
  FOUNTAIN_DURATION: 1.0,
  COIN_FLIGHT: 0.4,
  PALLET_PICKUP_RADIUS: 1.9,
  PICKUP_RATE: 100, // gold per second
  COIN_DIAMETER: 0.55,
  COIN_THICKNESS: 0.09,
  BACK_COLUMN_MAX_DISCS: 70,
  BURSAR_DELAY: 0.5,

  // --- pads ---
  PAD_PAY_RADIUS: 2.4,
  PAD_PAY_MAX_SPEED: 0.5,
  PAD_PAY_DWELL: 0.1,
  PAD_POP_TIME: 0.13,
  PAD_DONE_DELAY: 0.2,
  PAD_DIAMETER: 1.9,

  // --- ward ---
  BED_W: 2.7, // along x
  BED_D: 1.7, // along z
  NURSE_START_DELAY: 3.0,
  TREATMENT_TIME: 1.4, // nurse t=0 -> healed
  TREAT_JAB: 0.4,
  TREAT_PIE_START: 0.85,
  TREAT_BUBBLE_OUT: 1.6,
  TREAT_SIT_UP: 1.8,
  TREAT_HOP_OFF: 2.2,
  TREAT_END: 2.4,
  LIE_DOWN_TIME: 0.3,
  NEEDS_NURSE_DELAY: 0.15,

  // --- drill & rats ---
  DRILL_CREW: 2,
  DRILL_PUSH_DISTANCE: 5.5,
  DRILL_PUSH_TIME: 0.9,
  DRILL_KILL_START: 0.4,
  DRILL_COIN_FOUNTAIN: 0.6,
  DRILL_HEAP_HOLD: 0.1,
  DRILL_FLY_TO_HUD: 0.5,
  DRILL_RETURN_TIME: 0.6,
  DRILL_REWARD: 250,
  DRILL_REWARD_MK2: 500,
  RAT_COUNT: 150,
  RATS_KILLED_PER_SORTIE: 60,
  RAT_REGROW: 20,
  RAT_REGROW_MK2: 12,
  DRILL_LONE_WAIT: 8,
  DASHED_CIRCLE_RADIUS: 2.8,

  // --- helpers ---
  PORTER_SPEED: 5,
  PORTER_CARRY: 6,
  DRIVER_MIN_CYCLE: 8,

  // --- guide arrow ---
  ARROW_HOVER: 2.8,

  // --- camera ---
  CAMERA_OFFSET: [-13.1, 17.2, 15.8] as const,
  CAMERA_FOV: 38,
  CAMERA_TARGET_BIAS: [1.2, 0, -0.7] as const,
  CAMERA_LOOKAHEAD: 0.12,
  CAMERA_SMOOTH_TIME: 0.2,
  CAMERA_STATION_BLEND: 0.6,
  CAMERA_ZOOM_OPENING: 1.16, // until the first flask is made
  CAMERA_ZOOM_LATE: 1.12, // from ward 2 on

  // --- environment ---
  TILE_SIZE: 0.85,
  WALL_HEIGHT: 2.0,
  WALL_THICKNESS: 0.35,
  POST_SIZE: 0.6,
  POST_HEIGHT: 2.3,
} as const

/** Screen-up and screen-right directions projected on the ground (unit vectors). */
export const SCREEN_UP = { x: 0.64, z: -0.77 } as const
export const SCREEN_RIGHT = { x: 0.77, z: 0.64 } as const

export interface UnlockDef {
  id: UnlockId
  price: number
  x: number
  z: number
  /** Direction the price text baseline runs along. */
  textAlong: 'x' | 'z'
  icon: 'nurse' | 'usher' | 'cart' | 'ward' | 'porter' | 'chest' | 'cauldron' | 'drill' | 'driver'
  label: string
}

/** Purchase order is the array order. Appearance triggers are documented in SPEC 3.2 (sim/pads.ts implements them). */
export const UNLOCKS: readonly UnlockDef[] = [
  { id: 'nurses', price: 50, x: 1.65, z: 5.9, textAlong: 'z', icon: 'nurse', label: 'ナース' },
  { id: 'usher', price: 50, x: -3.9, z: -2.5, textAlong: 'z', icon: 'usher', label: '案内係' },
  { id: 'cart', price: 50, x: 10.4, z: -6.9, textAlong: 'z', icon: 'cart', label: '荷車' },
  { id: 'ward2', price: 100, x: -0.9, z: -5.4, textAlong: 'x', icon: 'ward', label: '第二病棟' },
  { id: 'porter', price: 250, x: 7.3, z: 0.6, textAlong: 'x', icon: 'porter', label: '運び手' },
  { id: 'bursar', price: 400, x: 4.0, z: 0.9, textAlong: 'x', icon: 'chest', label: '会計係' },
  { id: 'bigCauldron', price: 600, x: -2.7, z: 1.2, textAlong: 'x', icon: 'cauldron', label: '大釜拡張' },
  { id: 'drill2', price: 800, x: 1.8, z: 7.6, textAlong: 'x', icon: 'drill', label: 'ドリル改' },
  { id: 'driver', price: 1500, x: 12.6, z: -6.4, textAlong: 'z', icon: 'driver', label: '御者' },
]
/** discharged-count gates for the EXTENDED pads (SPEC 3.2). */
export const UNLOCK_DISCHARGE_GATE: Partial<Record<UnlockId, number>> = { porter: 10, bursar: 20, bigCauldron: 40, drill2: 60, driver: 90 }

export interface BedDef {
  id: number
  ward: 1 | 2
  x: number
  z: number
}
/** Index = bed id. Order = fill order (A, C, B, D, then ward-2 1..6). Bed heads point toward +x. */
export const BEDS: readonly BedDef[] = [
  { id: 0, ward: 1, x: 4.1, z: 5.8 }, // A
  { id: 1, ward: 1, x: 4.1, z: 9.5 }, // C
  { id: 2, ward: 1, x: -1.3, z: 5.8 }, // B
  { id: 3, ward: 1, x: -1.3, z: 9.5 }, // D
  { id: 4, ward: 2, x: 3.4, z: -15.2 },
  { id: 5, ward: 2, x: 3.4, z: -12.2 },
  { id: 6, ward: 2, x: 3.4, z: -9.2 },
  { id: 7, ward: 2, x: -1.6, z: -15.2 },
  { id: 8, ward: 2, x: -1.6, z: -12.2 },
  { id: 9, ward: 2, x: -1.6, z: -9.2 },
]

/** Layout constants (SPEC section 4.3 / 4.4). Rectangles are [x0, z0, x1, z1]. */
export const L = {
  CAULDRON: { x: 0, z: 0 },
  CAPACITY_LABEL: { x: -0.3, z: 3.0, w: 2.1, d: 0.9 },
  QUEUE_SLOT0: { x: -2.8, z: -0.7 },
  QUEUE_STEP: { x: -1.0, z: -0.25 },
  QUEUE_REAR: [
    { x: -6.2, z: -2.3 },
    { x: -6.2, z: -3.2 },
  ], // the big cauldron's fifth and sixth place: inside the pen bay, clear of the gate's swing
  BATH_SEATS: [
    { x: -0.55, z: -0.25 },
    { x: 0.55, z: 0.3 },
    { x: -0.25, z: 0.65 },
    { x: 0.3, z: -0.7 },
  ],
  BATH_EXITS: [
    { x: 2.9, z: 0.4 },
    { x: 2.8, z: 1.3 },
    { x: 3.0, z: -0.5 },
    { x: 2.6, z: 2.1 },
  ],
  COURTYARD: [-5.1, -6.1, 4.85, 4.0] as const,
  PALLET: { x: 3.9, z: 3.0, w: 1.6, d: 1.3, h: 0.15 },
  WARD1: [-4.9, 4.0, 6.5, 12.3] as const,
  WARD2: [-5.3, -16.5, 5.4, -6.1] as const,
  NURSE_POST: { x: 0.6, z: 1.5 }, // offset from bed centre
  BED_SIDE: { x: -0.9, z: 1.1 }, // offset from bed centre where a patient climbs on
  SIDE_TABLE: { x: 5.6, z: 7.7, s: 0.8 },
  WARD1_ENTRY: { x: 3.0, z: 3.8 },
  WARD1_DOOR: { x: 1.1, z: 12.3, w: 4.2 }, // double gate between the posts of the two south wall segments
  WARD1_DOOR_INSIDE: { x: 1.1, z: 11.3 },
  WARD2_ENTRY: [
    { x: 3.4, z: -3.6 },
    { x: 0.3, z: -5.6 },
    { x: 0.3, z: -7.2 },
  ],
  WARD2_AISLE_X: 0.6,
  NORTH_DOOR: { x: 0.6, z: -16.5, w: 3.3 },
  NORTH_EXIT: { x: 0.6, z: -22 },
  SOUTH_EXIT: { x: -1.2, z: 19.6 }, // healed villagers that do not crew the drill fade out here
  DRILL_PARK: { x: 1.95, z: 14.4, heading: 0 },
  DRILL_HANDLE: { x: 1.95, z: 13.4 }, // the crossbar, 1.0 m behind DRILL_PARK
  DRILL_END: { x: 1.95, z: 19.9 }, // P.DRILL_PUSH_DISTANCE along the heading
  DASHED_CIRCLE: { x: 1.8, z: 13.6 },
  RAT_FIELD: [-5.5, 12.7, 7.4, 21] as const,
  GRINDER: [8.5, -5.4, 10.8, -0.3] as const,
  FLASK_AREA: { x: 7.3, z: -2.5, w: 2.2, d: 3.4 },
  TOOL_REST: { x: 12.4, z: -3.5, heading: Math.PI / 2 },
  PLAYER_START: { x: 11.6, z: -2.6, heading: Math.PI / 2 },
  SPARE_SCOOP_REST: { x: 12.4, z: -1.5, heading: Math.PI / 2 }, // hand scoop for the player once the driver owns the cart
  PEN: { x: -5.1, z: -1.3, r: 2.6 },
  PEN_GATE: { x: -7.69, z: -1.07, w: 1.6, angleDeg: 5 }, // 5 deg south of west on the arc
  PEN_INNER: { x: -5.6, z: -1.4 },
  MANUAL_RELEASE: { x: -4.6, z: -1.8 },
  USHER_POST: { x: -5.35, z: -3.3 },
  CROWD_EDGE_X: -5.6,
  PORTER_HOME: { x: 7.0, z: 0.4 },
  PORTER_POUR: { x: 2.4, z: -3.2 },
  BURSAR_CHEST: { x: 5.0, z: 1.9 },
  /** River centreline polyline, flowing from the first point (north) to the last (south fall). */
  RIVER: [
    { x: 22.0, z: -24 },
    { x: 20.5, z: -14 },
    { x: 18.6, z: -6 },
    { x: 18.5, z: 0 },
    { x: 18.5, z: 4.2 },
  ],
  RIVER_HALF_WIDTH_N: 3.2,
  RIVER_HALF_WIDTH_S: 3.8,
  CLIFF_Z: 4.2,
  CLIFF_DROP: 1.5,
  FALL_DROP: 6.0, // the gorge under the river fall
  /** Walkable outer bounds for the player (SPEC 4.5). */
  BOUNDS: { x0: -8.4, x1: 21.8, z0: -21, z1: 12.0 },
  /** Boulders: x, z, radius (collider), visual size ~ 2r. */
  BOULDERS: [
    [13.2, 1.2, 1.0], [13.6, 2.6, 0.9],
    [13.5, -8.5, 1.1], [14.3, -10.5, 1.2], [15.0, -12.5, 1.1], [15.8, -14.5, 1.2],
    [22.6, -13, 1.2], [23.0, -9, 1.1], [22.8, -1, 1.1], [22.8, 2.5, 1.0],
  ] as readonly (readonly [number, number, number])[],
  CONIFERS: [
    [7.5, -11.8], [9.4, -11.2], [8.8, -16.8], [8.3, -18.5], [-2, -19.5], [3, -20], [11, -20], [1, -21.5], [-8, -19],
    [24.5, -17], [25, -6], [25, 1],
  ] as readonly (readonly [number, number])[],
  IRON_FENCE: { x: 22.9, z: -5, len: 5 },
  STRAY_SEED: { x: 12.4, z: -1.0, n: 6 },
  /** Wall segments [ax, az, bx, bz] (axis-aligned), SPEC 4.4. */
  WALLS: [
    [-5.3, -16.5, -5.3, -6.1], // yard west
    [-5.3, -16.5, -1.05, -16.5], [2.25, -16.5, 5.4, -16.5], // yard north (double door between)
    [5.4, -16.5, 5.4, -6.1], // yard east
    [-5.3, -6.1, -3.0, -6.1], [2.9, -6.1, 5.4, -6.1], // yard south stubs
    [-5.2, -6.1, -5.2, -3.9], // courtyard west, north part
    [-5.05, 1.6, -4.85, 4.05], // courtyard west, south part (slightly skewed)
    [-4.9, 4.05, -4.9, 12.3], // ward-1 west
    [-4.85, 4.05, -3.25, 4.05], // ward-1 north-west stub
    [4.8, 3.85, 6.4, 3.8], // ward-1 north-east stub
    [6.5, 3.8, 6.5, 12.3], // ward-1 east
    [-4.9, 12.3, -1.0, 12.3], [3.2, 12.3, 6.5, 12.3], // ward-1 south (double gate between)
  ] as readonly (readonly [number, number, number, number])[],
  /** Yard props that exist until 'ward2' is bought: [x, z, w, d]. */
  YARD_PROPS: [
    [4.4, -15.8, 1.1, 1.1], [4.3, -14.6, 1.1, 1.1], [2.9, -13.5, 1.8, 3.7], [-0.7, -10.6, 2.6, 1.0],
  ] as readonly (readonly [number, number, number, number])[],
} as const

/** Palette (SPEC 7.2). */
export const PAL = {
  dirt: 0x6e6b62, dirtLit: 0x88857c, dirtFar: 0x4f4e4a,
  tile: 0x848691, tileWarm: 0xa69b9a, tileShade: 0x797682, grout: 0x4d4850,
  plank: 0x77655b, plankLit: 0x937461, plankSeam: 0x433843,
  sand: 0x7d6f67,
  riverBed: 0x455160, riverBed2: 0x565c63,
  lowland: 0x2e4d48, lowland2: 0x3a5954,
  boulder: 0x606662, boulderLit: 0x7d8180, boulderShade: 0x313b3a,
  cliff: 0x3b464c, farDark: 0x1c292f, fog: 0x0d1720,
  conifer: 0x4f6163, coniferMid: 0x435556, coniferShade: 0x2b3637,
  wall: 0x55555d, wallShade: 0x312f3a, wallTop: 0x3e4145, postCap: 0x9e8387,
  ball: 0x16959e, ballHi: 0x3cd6da, ballShade: 0x155e6a,
  bubble: 0x16bdc8, bubbleHi: 0xc0fefe, bubbleShade: 0x0b7486,
  shard: 0x1cb5bf, shardLit: 0x75faf9, shardDark: 0x0b7486,
  flask: 0x49b3e4, flaskLight: 0x72e0f8, flaskSwirl: 0x2791cf, cork: 0x79664a,
  potion: 0xaaf3f7, foam: 0xd2f7f7,
  cauldronOut: 0x3d2e3b, cauldronIn: 0x4c484a, cauldronInBright: 0xc7bfb6,
  log: 0x664b48, logDark: 0x453738,
  fire: 0xe7853e, fireBright: 0xef961e, fireDark: 0xaa522b,
  coin: 0xd98c47, coinRim: 0xf4a361, coinEmboss: 0xa35819,
  scoopWood: 0xcf8f58, scoopWoodMid: 0x9e6039, scoopGrain: 0x5d371c, scoopEnd: 0xe0a670,
  cartWood: 0x835b43, cartDark: 0x473b36, cartWheel: 0x303c49, cartGear: 0x86593a, cartTeal: 0x2f9182,
  disc: 0x666874, discHi: 0x9c9fab, discGap: 0x2c2d33, trayRim: 0x7e7d75, trayIn: 0x56453e,
  coat: 0x403c43, skirt: 0x313947, hat: 0xfbf3f5, beak: 0xd4d4d9, pouchA: 0x986072, pouchB: 0xd27ab8,
  sickShirt: 0x5876b1, sickShirtLight: 0x7697d0, hair: 0x6f4e53, sickSkin: 0xa4aa5e,
  vest: 0x9fa1bd, shirt: 0xe8e4e0, trousers: 0x837d90, skin: 0xe1b1a6,
  miasma: 0x4ea459, miasmaDark: 0x1b652b, woundGlow: 0xf65c69,
  nurseHair: 0xa33e4e, nurseSkirt: 0x3d2d37, syringe: 0x58fb6c,
  usherHair: 0xca9399, usherSkirt: 0x453b3d,
  hood: 0x3a373e, cuff: 0x8c8c94, glove: 0x3f4a4f, hatBand: 0x2a2228, belt: 0x564a54, // doctor details (art.md 2.1)
  sickSleeve: 0xd8cbc4, usherBlouse: 0xc9bcc6, ratGrey: 0x676561, // characters (art.md 2.10, 2.13, 2.14)
  rat: 0x343237, ratEar: 0xf5f6f8, ratEye: 0xc93e65,
  drillSteel: 0x828387, drillHi: 0xb1b7bd, drillWheel: 0x201922,
  blanket: 0xa8686f, pillow: 0xe2c3c0, bedFrame: 0x7c6054,
  palletFrame: 0x353135, palletPlank: 0x736769,
  tableWood: 0x62544e, basin: 0xbaa69f, basinCloth: 0xb4d3ea, // side table (art.md 2.21)
  drillHousing: 0xb6aaa1, drillCone: 0x8c9eb2, // drill (ad 24.5 s): warm silver housing, blue steel cone
  uiGreen: 0x24ee34, arrow: 0x5aff2e, arrowBevel: 0x92fe5b, ring: 0xb9f567,
  terracotta: 0xaf694f, cream: 0xf0e1c9, alertRed: 0xac2b3c, alertRed2: 0xc34b66,
  drillCircle: 0xffda98, gold: 0xf4c671, goldCore: 0xfcdd88, hud: 0x272f34,
  // UI (SPEC 8.1 / 8.2): HUD pill, dividers, portrait tile, copper coin icon, pad brackets, capacity-label dashes
  hudPill: 0x23272a, hudDivider: 0x555557, hudPortrait: 0x4b60a4, hudBorder: 0xc1c9dd, hudBorderDark: 0x7d86a9,
  copper: 0xc3755b, padArc: 0xd0c5c1, labelDash: 0xcfcbcb,
  padFill: 0x4cc05c, padArcCore: 0xe6d8d5, drillCircleEdge: 0xe9953f, // pad pay fill / bracket core / drill-circle rim, sampled at 28.6 s, 17.6 s, 26.4 s
  // environment (art.md 2.19 / 2.21): doors, pen pickets, east-bank fence, yard crates
  doorWood: 0x2f292d, knob: 0x7d777b, picket: 0x84756d, picketShade: 0x493e40, picketTop: 0xbdb6ae,
  ironFence: 0x3f404a, crate: 0x504547, crateDark: 0x272226,
} as const

export const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
