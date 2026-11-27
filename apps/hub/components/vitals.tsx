import { vitalsMeters } from "@/lib/machines";
import type { Vitals } from "@/lib/machines";

interface MetersProps {
  vitals: Vitals | null;
}

export const Meters = ({ vitals }: MetersProps) => {
  if (vitals === null) {
    return null;
  }

  return (
    <div className="mt-4 grid gap-3 @md:grid-cols-3 @md:gap-6">
      {vitalsMeters(vitals).map(({ fill, high, label, value }) => (
        <div key={label}>
          <meter
            aria-label={label}
            aria-valuetext={value}
            className="sr-only"
            max={100}
            min={0}
            value={fill}
          />
          <div
            aria-hidden="true"
            className="flex items-baseline justify-between gap-2 text-xs"
          >
            <span className="text-muted">{label}</span>
            <span className="text-soft tabular-nums">{value}</span>
          </div>
          <div
            aria-hidden="true"
            className="bg-wash mt-1.5 h-1 overflow-hidden rounded-full"
          >
            <div
              className={`h-full rounded-full ${high ? "bg-accent" : "bg-soft"}`}
              style={{ width: `${fill}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};
