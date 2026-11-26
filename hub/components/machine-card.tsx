import type { PropsWithChildren } from "react";

import { CopyLink } from "@/components/copy";
import { MachineIcon } from "@/components/icons";
import { Strip } from "@/components/strip";
import { linkSentence, STATE_LABEL, t3Sentence } from "@/lib/machines";
import type { BarState, Machine, MachineState } from "@/lib/machines";

const TILE_CLASS = {
  offline: "border-rule text-muted border",
  online: "bg-wash text-soft",
  t3: "bg-(image:--tile) text-[#181d16]",
} satisfies Record<MachineState, string>;

export const Badge = ({ children }: PropsWithChildren) => (
  <span className="bg-wash text-nav text-soft inline-block shrink-0 rounded-full px-2.5 py-0.5 tracking-normal">
    {children}
  </span>
);

const Address = ({ machine }: { machine: Machine }) => {
  if (machine.tailscale) {
    return (
      <>
        <CopyLink text={machine.tailscale.dns} /> at {machine.tailscale.ip}.
      </>
    );
  }

  const [url] = machine.t3?.link?.urls ?? [];

  return url === undefined ? "Not on the tailnet." : `Reached at ${url}.`;
};

interface MachineCardProps {
  bars: readonly BarState[];
  machine: Machine;
  now: number;
}

export const MachineCard = ({ bars, machine, now }: MachineCardProps) => {
  const url = machine.t3?.url ?? null;

  return (
    <li className="animate-rise">
      <div className="edge squircle rounded-card @container mt-4 p-4">
        <div className="flex items-center gap-4 @max-md:flex-wrap">
          <span
            className={`grid size-14 shrink-0 place-items-center rounded-(--radius-icon) ${TILE_CLASS[machine.state]}`}
          >
            <MachineIcon className="size-7" />
          </span>
          <div className="min-w-0 flex-[1_1_9rem]">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate">{machine.name}</span>
              {machine.here ? <Badge>this machine</Badge> : null}
            </div>
            <div className="text-nav text-muted mt-0.5 truncate">
              {t3Sentence(machine, now)}
            </div>
          </div>
          {url === null ? (
            <Badge>{STATE_LABEL[machine.state]}</Badge>
          ) : (
            <a
              className="bg-ink text-nav text-paper shrink-0 rounded-full px-4 py-1.5 transition-opacity duration-100 hover:opacity-80"
              href={url}
              rel="noreferrer"
              target="_blank"
            >
              Open T3 Code
            </a>
          )}
        </div>
        <Strip bars={bars} />
      </div>
      <p className="text-nav text-soft mt-4">
        <Address machine={machine} />{" "}
        {linkSentence(machine.t3?.link ?? null, now)}
      </p>
    </li>
  );
};
