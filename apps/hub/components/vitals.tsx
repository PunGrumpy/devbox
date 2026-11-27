import { vitalsMeters } from "@/lib/machines";
import type { Vitals } from "@/lib/machines";

interface MetersProps {
  vitals: Vitals | null;
}

/** Load, memory and disk as three small meters in a row, stacked on a narrow card. */
export const Meters = ({ vitals }: MetersProps) => {
  if (vitals === null) {
    return null;
  }

  return (
    <div className="mt-4 grid gap-3 @md:grid-cols-3 @md:gap-6">
      {vitalsMeters(vitals).map(({ fill, high, label, value }) => (
        <div
          aria-label={label}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={fill}
          aria-valuetext={value}
          key={label}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native meter takes this track's look only through per-engine pseudo-elements
          role="meter"
        >
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted">{label}</span>
            <span className="text-soft tabular-nums">{value}</span>
          </div>
          <div className="bg-wash mt-1.5 h-1 overflow-hidden rounded-full">
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
