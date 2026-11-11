/**
 * Project document schema (v1). This is the single source of truth for what a
 * project file looks like. Units: meters, degrees, seconds; focal length in mm.
 *
 * Object-specific `params` are validated separately by the asset type registry
 * (see assetTypes.ts) and animation track values by the property registry
 * (see properties.ts).
 */
import { z } from 'zod';

export const FORMAT = 'director3d.project' as const;
export const FORMAT_VERSION = 1 as const;
export const MAX_DURATION = 30;
export const FPS_OPTIONS = [24, 25, 30, 50, 60] as const;

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const IdSchema = z
  .string()
  .regex(ID_PATTERN, 'id must start with a letter and contain only letters, digits, "_" or "-" (max 64 chars)');
export const ProjectIdSchema = z
  .string()
  .regex(PROJECT_ID_PATTERN, 'project id may contain only letters, digits, "_" or "-" (max 64 chars)');

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const v3 = (x: number, y: number, z: number) => (): [number, number, number] => [x, y, z];
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be "#rrggbb"');

export const EASES = ['linear', 'in', 'out', 'inOut', 'hold'] as const;
export const EaseSchema = z.enum(EASES);

export const KeyframeSchema = z.object({
  /** Time in seconds. */
  t: z.number().min(0).max(MAX_DURATION),
  /** Value; its type depends on the animated property. */
  v: z.unknown(),
  /** Easing used from this key to the next one. Default "inOut". */
  ease: EaseSchema.optional(),
});

export const TrackSchema = z.object({
  keys: z.array(KeyframeSchema),
  /** For position tracks: "smooth" makes the path a curve through the keys. */
  path: z.enum(['linear', 'smooth']).optional(),
});

export const SENSORS = ['fullFrame', 'super35', 'apsc', 'mft', 'oneInch', 'phone'] as const;
export const RIGS = ['tripod', 'handheld', 'dolly', 'crane', 'drone'] as const;
export const LENSES = ['standard', 'fisheye', 'panorama'] as const;
export const FISHEYE_MAPPINGS = ['equidistant', 'equisolid', 'stereographic', 'orthographic'] as const;
export const AIMS = ['auto', 'head', 'chest', 'center', 'feet'] as const;
export const SHAKES = ['none', 'handheld', 'walk', 'drone', 'vehicle', 'earthquake'] as const;

export const LookAtSchema = z.object({
  /** Object id to aim at (takes precedence over `point`). */
  target: IdSchema.nullable().default(null),
  /** World point to aim at when no target is set. */
  point: Vec3Schema.nullable().default(null),
  /** Which part of the target to aim at. */
  aim: z.enum(AIMS).default('auto'),
  /** Extra world-space offset added to the aim point (meters). */
  offset: Vec3Schema.default(v3(0, 0, 0)),
});

export const FollowSchema = z.object({
  target: IdSchema,
  /** Offset from the target (meters). In "local" space it rotates with the target's facing. */
  offset: Vec3Schema.default(v3(0, 2, 5)),
  space: z.enum(['world', 'local']).default('world'),
  /** Seconds of delay, for a lazier follow. */
  lag: z.number().min(0).max(5).default(0),
});

export const CameraSchema = z.object({
  rig: z.enum(RIGS).default('tripod'),
  lens: z.enum(LENSES).default('standard'),
  focalLength: z.number().min(2).max(1200).default(35),
  sensor: z.enum(SENSORS).default('super35'),
  fisheye: z
    .object({
      fov: z.number().min(60).max(360).default(180),
      mapping: z.enum(FISHEYE_MAPPINGS).default('equidistant'),
      /** true = full image circle visible (black corners); false = frame is filled. */
      circular: z.boolean().default(false),
    })
    .prefault({}),
  lookAt: LookAtSchema.nullable().default(null),
  follow: FollowSchema.nullable().default(null),
  shake: z
    .object({
      preset: z.enum(SHAKES).default('none'),
      amount: z.number().min(0).max(2).default(0.5),
      seed: z.number().int().min(0).max(1_000_000).default(1),
    })
    .prefault({}),
});

export const SceneObjectSchema = z.object({
  id: IdSchema,
  type: z.string().min(1),
  name: z.string().max(120).default(''),
  color: ColorSchema.default('#9aa4b2'),
  position: Vec3Schema.default(v3(0, 0, 0)),
  /** Euler degrees [x, y, z], order YXZ. y = yaw (positive turns left), x = pitch (positive looks up), z = roll. */
  rotation: Vec3Schema.default(v3(0, 0, 0)),
  scale: Vec3Schema.default(v3(1, 1, 1)),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  /** Type-specific parameters (see assetTypes). */
  params: z.record(z.string(), z.unknown()).default(() => ({})),
  /** Only for type "camera". */
  camera: CameraSchema.optional(),
  /** Animation tracks keyed by property path, e.g. "position", "camera.focalLength", "params.pose". */
  tracks: z.record(z.string(), TrackSchema).default(() => ({})),
  note: z.string().max(2000).optional(),
});

export const ENV_PRESETS = ['day', 'golden', 'dusk', 'night', 'overcast', 'studio'] as const;

export const EnvironmentSchema = z.object({
  preset: z.enum(ENV_PRESETS).default('day'),
  /** Overrides the preset's sky color. */
  skyColor: ColorSchema.nullable().default(null),
  /** Sun direction: azimuth 0 = from north, 90 = from east (degrees). */
  sunAzimuth: z.number().min(-360).max(360).default(135),
  sunElevation: z.number().min(-10).max(90).default(50),
  fog: z.boolean().default(true),
  /** 0 = very light haze, 1 = thick fog. */
  fogDensity: z.number().min(0).max(1).default(0.2),
  shadows: z.boolean().default(false),
});

export const SettingsSchema = z.object({
  duration: z.number().min(1).max(MAX_DURATION).default(10),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(24),
  /** Aspect preset key ("16:9", "9:16", "2.39:1", ...) or "custom". */
  aspect: z.string().default('16:9'),
  /** Output frame size in pixels [width, height] (even numbers). */
  resolution: z
    .tuple([z.number().int().min(16).max(8192), z.number().int().min(16).max(8192)])
    .default((): [number, number] => [1920, 1080]),
  environment: EnvironmentSchema.prefault({}),
});

export const CutSchema = z.object({
  t: z.number().min(0).max(MAX_DURATION),
  camera: IdSchema,
});

export const MarkerSchema = z.object({
  t: z.number().min(0).max(MAX_DURATION),
  label: z.string().max(200),
  color: ColorSchema.optional(),
});

export const ProjectSchema = z.object({
  format: z.literal(FORMAT).default(FORMAT),
  version: z.literal(FORMAT_VERSION).default(FORMAT_VERSION),
  id: ProjectIdSchema,
  name: z.string().max(200).default('未命名專案'),
  /** Incremented on every save; used to detect external edits. */
  revision: z.number().int().min(0).default(0),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  settings: SettingsSchema.prefault({}),
  objects: z.array(SceneObjectSchema).default(() => []),
  /** Edit decision list: which camera is live from time t (hard cuts). */
  cuts: z.array(CutSchema).default(() => []),
  /** Named beats on the timeline (dialogue lines, actions...). */
  markers: z.array(MarkerSchema).default(() => []),
  /** Free text: script, shot notes. */
  notes: z.string().max(20000).optional(),
});

export type Vec3 = [number, number, number];
export type Ease = (typeof EASES)[number];
export type Keyframe = z.output<typeof KeyframeSchema>;
export type Track = z.output<typeof TrackSchema>;
export type CameraSettings = z.output<typeof CameraSchema>;
export type LookAt = z.output<typeof LookAtSchema>;
export type Follow = z.output<typeof FollowSchema>;
export type SceneObject = z.output<typeof SceneObjectSchema>;
export type Environment = z.output<typeof EnvironmentSchema>;
export type Settings = z.output<typeof SettingsSchema>;
export type Cut = z.output<typeof CutSchema>;
export type Marker = z.output<typeof MarkerSchema>;
export type Project = z.output<typeof ProjectSchema>;
export type Sensor = (typeof SENSORS)[number];
export type Rig = (typeof RIGS)[number];
export type Lens = (typeof LENSES)[number];
export type FisheyeMapping = (typeof FISHEYE_MAPPINGS)[number];
export type Aim = (typeof AIMS)[number];
export type ShakePreset = (typeof SHAKES)[number];
export type EnvPreset = (typeof ENV_PRESETS)[number];

/** Default camera block (all defaults applied). */
export function defaultCamera(overrides: Partial<z.input<typeof CameraSchema>> = {}): CameraSettings {
  return CameraSchema.parse(overrides);
}
