const BUCKET_COUNT = 48;
const BUCKET_SECONDS = 1800;
const BUCKET_MS = BUCKET_SECONDS * 1000;
const DAY_MIN_SAMPLES = 30;
const CENTER_OFFSET = 0.5;
const MEDIAN = 0.5;
const P95 = 0.95;
const P99 = 0.99;
const PRECISION = 100;
const TIME_DIGITS = 2;

interface Point {
  x: number;
  y: number;
}

const isFiniteNumber = (value: number | null): value is number =>
  value !== null && Number.isFinite(value);

const roundCoord = (value: number) => Math.round(value * PRECISION) / PRECISION;

const joinPoints = (points: readonly Point[]) =>
  points.map(({ x, y }) => `${x} ${y}`).join(" L ");

const quantileOf = (sorted: readonly number[], quantile: number) => {
  const rank = (sorted.length - 1) * quantile;
  const low = sorted[Math.floor(rank)];
  const high = sorted[Math.ceil(rank)];

  if (low === undefined || high === undefined) {
    return null;
  }

  return low + (high - low) * (rank - Math.floor(rank));
};

const sortedAnswers = (samples: readonly (number | null)[]) =>
  samples.filter(isFiniteNumber).toSorted((a, b) => a - b);

/**
 * Splits a machine's latency samples into 48 half-hour medians aligned with the 48 bars of Strip,
 * returning null where T3 Code did not answer in that half hour.
 */
export const latencyBuckets = (
  samples: readonly (number | null)[],
  sampleSeconds: number
) => {
  const perBucket = Math.max(1, Math.round(BUCKET_SECONDS / sampleSeconds));

  return Array.from({ length: BUCKET_COUNT }, (_, bucket) => {
    const end = samples.length - (BUCKET_COUNT - 1 - bucket) * perBucket;

    const slice = samples.slice(Math.max(0, end - perBucket), Math.max(0, end));

    return quantileOf(sortedAnswers(slice), MEDIAN) satisfies number | null;
  });
};

/**
 * The p50, p95 and p99 answer times over the day's samples in whole milliseconds, or null when
 * fewer than 30 samples answered.
 */
export const latencyPercentiles = (samples: readonly (number | null)[]) => {
  const sorted = sortedAnswers(samples);

  if (sorted.length < DAY_MIN_SAMPLES) {
    return null;
  }

  const at = (quantile: number) =>
    Math.round(quantileOf(sorted, quantile) ?? 0);

  return { p50: at(MEDIAN), p95: at(P95), p99: at(P99) };
};

/**
 * The SVG paths of the latency area chart: a line through the 48 buckets and the fill under it
 * down to the bottom edge, both broken where a bucket is null. The bottom is 0 ms and the top is
 * the slowest half hour, which `max` gives in whole milliseconds. Returns null when every bucket
 * is null.
 */
export const latencyChart = (
  buckets: readonly (number | null)[],
  width: number,
  height: number
) => {
  const values = buckets.filter(isFiniteNumber);

  if (values.length === 0) {
    return null;
  }

  const max = Math.max(...values);
  const runs: Point[][] = [];
  let run: Point[] = [];

  for (const [index, value] of buckets.entries()) {
    if (!isFiniteNumber(value)) {
      run = [];
      continue;
    }

    if (run.length === 0) {
      runs.push(run);
    }

    run.push({
      x: roundCoord(((index + CENTER_OFFSET) / buckets.length) * width),
      y: roundCoord(max === 0 ? height : (1 - value / max) * height),
    });
  }

  const line = runs.map(
    (points) =>
      `M ${joinPoints(points.length === 1 ? [...points, ...points] : points)}`
  );

  const area = runs.map((points) => {
    const xs = points.map(({ x }) => x);
    const left = { x: Math.min(...xs), y: height };
    const right = { x: Math.max(...xs), y: height };

    return `M ${joinPoints([left, ...points, right])} Z`;
  });

  return { area: area.join(" "), line: line.join(" "), max: Math.round(max) };
};

const twoDigits = (value: number) => String(value).padStart(TIME_DIGITS, "0");

/**
 * One tooltip per bucket: the start of that half hour in the reader's local time and its median,
 * such as `14:30, 42 ms` or `14:30, no answer`. The last bucket ends at `generatedAt`.
 */
export const latencyLabels = (
  buckets: readonly (number | null)[],
  generatedAt: string
) => {
  const newest = Date.parse(generatedAt);

  return buckets.map((value, index) => {
    const start = new Date(newest - (buckets.length - index) * BUCKET_MS);
    const time = `${twoDigits(start.getHours())}:${twoDigits(start.getMinutes())}`;

    return isFiniteNumber(value)
      ? `${time}, ${Math.round(value)} ms`
      : `${time}, no answer`;
  });
};
