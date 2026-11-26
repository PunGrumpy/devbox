import { CopyText } from "@/components/copy";
import { ArrowIcon } from "@/components/icons";
import { Strip } from "@/components/strip";
import { describe, STATE_LABEL } from "@/lib/machines";
import type { BarState, Machine, MachineState } from "@/lib/machines";

const STAGGER_MS = 40;
const STAGGER_ITEMS = 8;

const STATE_CLASS = {
  offline: "text-muted",
  online: "",
  t3: "gradient-text",
} satisfies Record<MachineState, string>;

const Address = ({ machine }: { machine: Machine }) => {
  if (machine.tailscale) {
    return (
      <>
        <CopyText text={machine.tailscale.dns} />
        <span>{machine.tailscale.ip}</span>
        <span>{machine.tailscale.os}</span>
      </>
    );
  }

  const [url] = machine.t3?.link?.urls ?? [];

  return <span>{url ?? "Not on the tailnet"}</span>;
};

interface MachineItemProps {
  bars: readonly BarState[];
  hidden: boolean;
  index: number;
  machine: Machine;
  now: number;
}

export const MachineItem = ({
  bars,
  hidden,
  index,
  machine,
  now,
}: MachineItemProps) => {
  const url = machine.t3?.url ?? null;

  return (
    <li
      className="border-rule animate-rise flex gap-4 border-t py-6 first:border-t-0 first:pt-0"
      hidden={hidden}
      style={{
        animationDelay: `${Math.min(index, STAGGER_ITEMS) * STAGGER_MS}ms`,
      }}
    >
      <span className="text-muted w-4 shrink-0 tabular-nums">{index + 1}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h3 className="flex min-w-0 items-baseline gap-3 font-medium">
            <span className="truncate">{machine.name}</span>
            {machine.here ? (
              <span className="text-caption text-muted shrink-0 font-normal">
                this machine
              </span>
            ) : null}
          </h3>
          <span className={`shrink-0 ${STATE_CLASS[machine.state]}`}>
            {STATE_LABEL[machine.state]}
          </span>
        </div>
        <p className="text-muted">{describe(machine, now)}</p>
        <div className="text-caption text-muted flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 font-mono">
          <Address machine={machine} />
          {url === null ? null : (
            <a
              className="group/open text-ink inline-flex items-baseline gap-1 font-sans underline-offset-4 hover:underline"
              href={url}
              rel="noreferrer"
              target="_blank"
            >
              Open T3 Code
              <ArrowIcon className="ease-press transition-transform duration-150 group-hover/open:translate-x-px group-hover/open:-translate-y-px" />
            </a>
          )}
        </div>
        <div className="mt-2">
          <Strip bars={bars} />
        </div>
      </div>
    </li>
  );
};
