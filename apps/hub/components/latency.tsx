import { useId } from "react";

import { latencyChart, latencyLabels } from "@/lib/latency";
import type { latencyPercentiles } from "@/lib/latency";

const WIDTH = 480;
const HEIGHT = 36;

/** The day of T3 Code answer times a machine card draws. */
export interface LatencyProps {
  buckets: readonly (number | null)[];
  generatedAt: string;
  percentiles: ReturnType<typeof latencyPercentiles>;
}

/**
 * The last 24 hours of T3 Code's answer time as an area chart, one median per half hour, newest on
 * the right, with its scale at the right and the day's p50, p95 and p99 under it.
 */
export const Latency = ({
  buckets,
  generatedAt,
  percentiles,
}: LatencyProps) => {
  const fade = useId();
  const chart = latencyChart(buckets, WIDTH, HEIGHT);

  if (percentiles === null || chart === null) {
    return null;
  }

  const labels = latencyLabels(buckets, generatedAt);
  const step = WIDTH / buckets.length;

  return (
    <div className="mt-4">
      <div className="flex gap-3">
        <svg
          aria-hidden="true"
          className="border-rule text-soft block h-9 min-w-0 flex-1 overflow-visible border-y"
          preserveAspectRatio="none"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        >
          <defs>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              id={fade}
              x1="0"
              x2="0"
              y1="0"
              y2={HEIGHT}
            >
              <stop offset="0" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={chart.area} fill={`url(#${fade})`} />
          <path
            d={chart.line}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          {labels.map((label, index) => (
            <rect
              fill="transparent"
              height={HEIGHT}
              key={label}
              width={step}
              x={index * step}
              y="0"
            >
              <title>{label}</title>
            </rect>
          ))}
        </svg>
        <div
          aria-hidden="true"
          className="text-muted -my-2 flex flex-col justify-between text-right text-xs tabular-nums"
        >
          <span>{chart.max} ms</span>
          <span>0</span>
        </div>
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5 text-xs tabular-nums">
        {Object.entries(percentiles).map(([name, value]) => (
          <li
            className="bg-wash text-soft rounded-full px-2 py-0.5 tracking-normal"
            key={name}
          >
            <span className="text-muted">{name}</span> {value} ms
          </li>
        ))}
      </ul>
    </div>
  );
};
