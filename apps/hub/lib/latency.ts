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

export const latencyPercentiles = (samples: readonly (number | null)[]) => {
  const sorted = sortedAnswers(samples);

  if (sorted.length < DAY_MIN_SAMPLES) {
    return null;
  }

  const at = (quantile: number) =>
    Math.round(quantileOf(sorted, quantile) ?? 0);

  return { p50: at(MEDIAN), p95: at(P95), p99: at(P99) };
};

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
