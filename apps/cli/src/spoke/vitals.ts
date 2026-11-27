import { Schema } from "effect";

export interface Vitals {
  /** The one minute load average divided by the number of cores. */
  readonly load: number;
  /** NonNegative. */
  readonly memory: { readonly used: number; readonly total: number };
  /** NonNegative, for the filesystem that holds the home directory. */
  readonly disk: { readonly used: number; readonly total: number };
}

/** What the system reports, before it means anything. */
export interface Readings {
  readonly load1: number;
  readonly cores: number;
  readonly memory: { readonly total: number; readonly available: number };
  readonly disk: {
    readonly blocks: number;
    readonly free: number;
    readonly blockSize: number;
  };
}

/** Memory in use is what the kernel says a new program could not have without swapping. */
export const vitalsOf = (r: Readings): Vitals => ({
  load: r.cores > 0 ? Math.round((r.load1 / r.cores) * 1000) / 1000 : 0,
  memory: {
    used: Math.max(0, r.memory.total - r.memory.available),
    total: r.memory.total,
  },
  disk: {
    used: Math.max(0, (r.disk.blocks - r.disk.free) * r.disk.blockSize),
    total: r.disk.blocks * r.disk.blockSize,
  },
});

export const SPOKE_PORT = 3782;

/** What a machine knows itself to be. */
export type SelfKind = "vm" | "wsl" | "computer" | "mac";

const NonNegative = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0))
);

const Used = Schema.Struct({ used: NonNegative, total: NonNegative });

/** `GET /api/spoke`, parsed where the hub reads it. */
export const SpokeAnswer = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literals(["vm", "wsl", "computer", "mac"]),
    vitals: Schema.Struct({ load: NonNegative, memory: Used, disk: Used }),
    trusts: Schema.Array(Schema.String),
  })
);

export type SpokeAnswer = typeof SpokeAnswer.Type;
