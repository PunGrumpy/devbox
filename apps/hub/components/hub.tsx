"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import { CommandTabs } from "@/components/command";
import { HubLogo, OsIcon } from "@/components/icons";
import { LoginGate } from "@/components/login";
import { MachineCard } from "@/components/machine-card";
import { Menu } from "@/components/menu";
import { Settings } from "@/components/settings";
import { Sidebar } from "@/components/sidebar";
import { latencyBuckets, latencyPercentiles } from "@/lib/latency";
import {
  ago,
  bars,
  daySentences,
  FILTERS,
  groupByOs,
  lead,
  summarize,
} from "@/lib/machines";
import type { FilterKey, Machine, Snapshot } from "@/lib/machines";
import { anchorOf } from "@/lib/search";
import {
  getHubState,
  getNow,
  getServerHubState,
  getServerNow,
  refresh,
  signOut,
  subscribe,
} from "@/lib/store";
import type { HubStatus } from "@/lib/store";

const FALLBACK_ORIGIN = "http://127.0.0.1:3780";
const getOrigin = () => window.location.origin;
const getServerOrigin = () => FALLBACK_ORIGIN;

const getShortcut = () =>
  /Macintosh|Mac OS X/u.test(navigator.userAgent) ? "⌘K" : "Ctrl K";

const getServerShortcut = () => "Ctrl K";

const statusText = (snapshot: Snapshot, status: HubStatus, now: number) => {
  const checked = ago(snapshot.generatedAt, now);

  return status === "not-answering"
    ? `Not answering, checked ${checked}`
    : `Checked ${checked}`;
};

const matching = (machines: readonly Machine[], filter: FilterKey) => {
  const test = FILTERS.find((candidate) => candidate.key === filter)?.test;

  return machines.filter((machine) => test?.(machine) ?? true);
};

const daysOf = ({ generatedAt, history, latest, machines }: Snapshot) =>
  new Map(
    machines.map((machine) => {
      const states = history.states[machine.name] ?? "";
      const samples = history.latency[machine.name] ?? [];

      return [
        machine.name,
        {
          bars: bars(states, history.sampleSeconds),
          day: daySentences(machine, states, latest.t3),
          latency: {
            generatedAt,
            buckets: latencyBuckets(samples, history.sampleSeconds),
            percentiles: latencyPercentiles(samples),
          },
        },
      ];
    })
  );

const Agents = () => {
  const origin = useSyncExternalStore(subscribe, getOrigin, getServerOrigin);

  return (
    <section>
      <h2 className="text-heading pt-16" id="agents">
        For agents
      </h2>
      <p className="text-soft mt-4">
        The same list is available as JSON. An agent reads it before it picks a
        machine, then reaches a linked one by its environment id.
      </p>
      <CommandTabs
        items={[
          { label: "devbox", text: "devbox machines --json" },
          {
            label: "curl",
            text: `curl -s -H "authorization: Bearer $(devbox hub token)" ${origin}/api/machines`,
          },
        ]}
      />
    </section>
  );
};

interface HubContentProps {
  snapshot: Snapshot;
  status: HubStatus;
}

const HubContent = ({ snapshot, status }: HubContentProps) => {
  const now = useSyncExternalStore(subscribe, getNow, getServerNow);

  const shortcut = useSyncExternalStore(
    subscribe,
    getShortcut,
    getServerShortcut
  );

  const [filter, setFilter] = useState<FilterKey>("all");
  const { machines } = snapshot;
  const days = useMemo(() => daysOf(snapshot), [snapshot]);
  const groups = groupByOs(matching(machines, filter));
  const { linked, ready } = summarize(machines);
  const failing = status === "not-answering";

  const jump = (name: string) => {
    setFilter("all");
    requestAnimationFrame(() => {
      document
        .querySelector(`#${CSS.escape(anchorOf(name))}`)
        ?.scrollIntoView();
    });
  };

  const nav = {
    filter,
    machines,
    onFilter: setFilter,
    onRefresh: () => {
      void refresh();
    },
    onSignOut: () => {
      void signOut();
    },
    sections: groups,
    status: statusText(snapshot, status, now),
  };

  return (
    <div className="side:mr-auto side:ml-[max(15rem,calc(50vw-18rem))] side:pt-20 side:pr-8 side:pl-0 docs:mx-auto docs:px-4 mx-auto min-h-screen max-w-(--measure) px-6 pt-8 pb-16">
      <Sidebar {...nav} now={now} onJump={jump} shortcut={shortcut} />
      <Menu {...nav} now={now} onJump={jump} />
      <main className="side:pt-0 pt-10">
        <h1 className="text-title side:before:inline-block side:before:h-12 pb-2 before:content-['']">
          Machines
        </h1>
        <p className="text-soft mt-4">
          <strong className="text-ink font-normal">
            {lead(machines, failing)}
            {` T3 Code answers on ${ready}, and ${linked} ${linked === 1 ? "is" : "are"} linked for agents.`}
          </strong>
        </p>
        <p className="text-soft mt-4">
          The hub checks every {snapshot.history.sampleSeconds} seconds and
          keeps the last 24 hours. Each bar under a machine is 30 minutes.
        </p>
        {snapshot.tailscale ? null : (
          <p className="border-rule rounded-panel text-nav text-soft mt-4 border p-4">
            Tailscale did not answer on the hub machine, so this list holds only
            that machine and its links.
          </p>
        )}

        {groups.map(({ key, label, machines: members }, position) => (
          <section key={key}>
            <h2
              className={`text-heading flex items-center ${position === 0 ? "pt-10" : "pt-16"}`}
              id={key}
            >
              <OsIcon
                className="-mt-0.5 mr-1.5 size-[1.2em] shrink-0"
                os={key}
              />
              {label}
              <span className="text-nav text-soft ml-auto tracking-normal tabular-nums">
                {members.length}
              </span>
            </h2>
            <ul>
              {members.map((machine) => {
                const day = days.get(machine.name);

                return day === undefined ? null : (
                  <MachineCard
                    {...day}
                    cloudflare={snapshot.cloudflare}
                    hubKey={snapshot.key}
                    key={machine.name}
                    latest={snapshot.latest.t3}
                    machine={machine}
                    now={now}
                  />
                );
              })}
            </ul>
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="border-rule rounded-panel text-nav text-soft mt-10 border p-4">
            No machine matches this filter.
          </p>
        ) : null}

        <Agents />
        <Settings
          cloudflare={snapshot.cloudflare}
          hubKey={snapshot.key}
          machines={machines}
        />
      </main>
    </div>
  );
};

const PendingGate = ({ failing }: { failing: boolean }) => (
  <main className="mx-auto flex min-h-screen max-w-[26rem] flex-col justify-center px-6 py-16">
    <HubLogo className="size-12" />
    <p className="text-nav text-soft mt-6">{lead(null, failing)}</p>
    {failing ? (
      <div className="mt-4">
        <button
          className="edge text-nav text-soft hover:text-ink cursor-pointer rounded-full px-4 py-1.5 transition-colors duration-100 [--fill:var(--surface)]"
          onClick={() => {
            void refresh();
          }}
          type="button"
        >
          Try again
        </button>
      </div>
    ) : null}
  </main>
);

export const Hub = () => {
  const { snapshot, status } = useSyncExternalStore(
    subscribe,
    getHubState,
    getServerHubState
  );

  if (status === "signed-out") {
    return <LoginGate />;
  }

  if (snapshot === null) {
    return <PendingGate failing={status === "not-answering"} />;
  }

  return <HubContent snapshot={snapshot} status={status} />;
};
