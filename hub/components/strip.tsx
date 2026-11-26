import { BAR_COUNT } from "@/lib/machines";
import type { BarState } from "@/lib/machines";

const BAR_IDS = Array.from({ length: BAR_COUNT }, (_, bar) => `bar-${bar}`);

const BAR_CLASS = {
  offline: "bg-rule",
  online: "bg-muted/60",
  t3: "gradient-fill",
  unknown: "shadow-[inset_0_-1px_0_var(--rule)]",
} satisfies Record<BarState, string>;

interface StripProps {
  bars: readonly BarState[];
}

/** The last 24 hours of one machine, one bar per half hour, newest on the right. */
export const Strip = ({ bars }: StripProps) => (
  <span
    aria-hidden="true"
    className="grid h-3 grid-cols-[repeat(48,minmax(0,1fr))] gap-px sm:gap-0.5"
  >
    {BAR_IDS.map((id, bar) => (
      <span
        className={`transition-colors duration-200 ${BAR_CLASS[bars[bar] ?? "unknown"]}`}
        key={id}
      />
    ))}
  </span>
);
