"use client";

import type { PropsWithChildren } from "react";

import {
  ActionButton,
  ActionNotice,
  UntrustedNote,
  useMachineAction,
} from "@/components/actions";
import { CopyLink } from "@/components/copy";
import { KindIcon } from "@/components/icons";
import { Latency } from "@/components/latency";
import type { LatencyProps } from "@/components/latency";
import { Strip } from "@/components/strip";
import { Meters } from "@/components/vitals";
import { eligibleActions, needsUpdate } from "@/lib/actions";
import { linkSentence, STATE_LABEL, t3Sentence } from "@/lib/machines";
import type { BarState, Cloudflare, Machine } from "@/lib/machines";
import { anchorOf } from "@/lib/search";

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
  cloudflare?: Cloudflare | null;
  day: string;
  hubKey?: string | null;
  latency: LatencyProps;
  latest?: string | null;
  machine: Machine;
  now: number;
}

export const MachineCard = ({
  bars,
  cloudflare = null,
  day,
  hubKey = null,
  latency,
  latest = null,
  machine,
  now,
}: MachineCardProps) => {
  const url = machine.t3?.url ?? null;
  const outdated = needsUpdate(machine, latest);
  const actions = eligibleActions(machine, latest, cloudflare);
  const action = useMachineAction(machine.name);
  const publicUrl = cloudflare === null ? null : (machine.tunnel?.url ?? null);

  return (
    <li className="scroll-mt-10" id={anchorOf(machine.name)}>
      <div className="animate-rise">
        <div className="edge squircle rounded-card @container mt-4 p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <KindIcon kind={machine.kind} state={machine.state} />
            <div className="min-w-0 flex-[1_1_9rem] @md:flex-[1_1_13rem]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate">{machine.name}</span>
                {machine.here ? <Badge>this machine</Badge> : null}
              </div>
              <div className="text-nav text-muted mt-0.5 truncate">
                {t3Sentence(machine, now)}
              </div>
            </div>
            <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
              {actions.map((kind) => (
                <ActionButton
                  action={kind}
                  key={kind}
                  onTrigger={action.handleTrigger}
                  state={action.state}
                />
              ))}
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
          </div>
          <Strip bars={bars} />
          <Latency {...latency} />
          <Meters vitals={machine.vitals} />
          <ActionNotice
            eligible={actions}
            name={machine.name}
            onCancel={action.handleCancel}
            onConfirm={action.handleConfirm}
            state={action.state}
            zone={cloudflare?.zone ?? null}
          />
        </div>
        <p className="text-nav text-soft mt-4">
          <Address machine={machine} />{" "}
          {linkSentence(machine.t3?.link ?? null, now)}
          {day === "" ? null : ` ${day}`}
          {publicUrl === null ? null : (
            <>
              {" "}
              Public at{" "}
              <span className="[&_button]:inline [&_button]:text-left [&_button]:break-all">
                <CopyLink text={publicUrl} />
              </span>
              .
            </>
          )}
          <UntrustedNote
            hubKey={hubKey}
            name={machine.name}
            show={outdated && machine.spoke === "untrusted"}
          />
        </p>
      </div>
    </li>
  );
};
