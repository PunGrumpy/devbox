import { BAR_COUNT } from "@/lib/machines";
import type { BarState } from "@/lib/machines";

const BAR_IDS = Array.from({ length: BAR_COUNT }, (_, bar) => `bar-${bar}`);

const BAR_CLASS = {
  offline: "bg-rule",
  online: "bg-muted",
  t3: "bg-accent",
  unknown: "shadow-[inset_0_-1px_0_var(--rule)]",
} satisfies Record<BarState, string>;

interface StripProps {
  bars: readonly BarState[];
}

/** The last 24 hours of one machine, one bar per half hour, newest on the right. */
export const Strip = ({ bars }: StripProps) => (
  <div aria-hidden="true" className="mt-4">
    <div className="grid h-2 grid-cols-[repeat(48,minmax(0,1fr))] gap-0.5">
      {BAR_IDS.map((id, bar) => (
        <span
          className={`rounded-[1px] ${BAR_CLASS[bars[bar] ?? "unknown"]}`}
          key={id}
        />
      ))}
    </div>
    <div className="text-muted mt-1.5 flex justify-between text-xs">
      <span>24h ago</span>
      <span>now</span>
    </div>
  </div>
);
