import type { PropsWithChildren } from "react";

import { CopyLink } from "@/components/copy";
import { KindIcon } from "@/components/icons";
import { Strip } from "@/components/strip";
import { linkSentence, STATE_LABEL, t3Sentence } from "@/lib/machines";
import type { BarState, Machine } from "@/lib/machines";

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
  day: string;
  machine: Machine;
  now: number;
}

export const MachineCard = ({ bars, day, machine, now }: MachineCardProps) => {
  const url = machine.t3?.url ?? null;

  return (
    <li className="animate-rise">
      <div className="edge squircle rounded-card @container mt-4 p-4">
        <div className="flex items-center gap-4 @max-md:flex-wrap">
          <KindIcon kind={machine.kind} state={machine.state} />
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
        {linkSentence(machine.t3?.link ?? null, now)} {day}
      </p>
    </li>
  );
};
