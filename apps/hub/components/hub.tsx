"use client";

import { useRef, useState, useSyncExternalStore } from "react";

import { CodeBlock } from "@/components/copy";
import { OsIcon } from "@/components/icons";
import { MachineCard } from "@/components/machine-card";
import { Menu } from "@/components/menu";
import { Search } from "@/components/search";
import { Sidebar } from "@/components/sidebar";
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
  subscribe,
} from "@/lib/store";

const FALLBACK_ORIGIN = "http://127.0.0.1:3780";
const getOrigin = () => window.location.origin;
const getServerOrigin = () => FALLBACK_ORIGIN;

const getShortcut = () =>
  /Macintosh|Mac OS X/u.test(navigator.userAgent) ? "⌘K" : "Ctrl K";

const getServerShortcut = () => "Ctrl K";

const statusText = (
  snapshot: Snapshot | null,
  failing: boolean,
  now: number
) => {
  if (!snapshot) {
    return failing ? "Not answering" : "Checking";
  }

  const checked = ago(snapshot.generatedAt, now);

  return failing ? `Not answering, checked ${checked}` : `Checked ${checked}`;
};

const matching = (machines: readonly Machine[], filter: FilterKey) => {
  const test = FILTERS.find((candidate) => candidate.key === filter)?.test;

  return machines.filter((machine) => test?.(machine) ?? true);
};

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
      <CodeBlock text="devbox machines --json" />
      <CodeBlock text={`curl -s ${origin}/api/machines`} />
    </section>
  );
};

export const Hub = () => {
  const { failing, snapshot } = useSyncExternalStore(
    subscribe,
    getHubState,
    getServerHubState
  );

  const now = useSyncExternalStore(subscribe, getNow, getServerNow);

  const shortcut = useSyncExternalStore(
    subscribe,
    getShortcut,
    getServerShortcut
  );

  const [filter, setFilter] = useState<FilterKey>("all");
  const palette = useRef<HTMLDialogElement>(null);
  const machines = snapshot?.machines ?? [];
  const groups = groupByOs(matching(machines, filter));
  const { linked, ready } = summarize(machines);

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
    sections: groups,
    status: statusText(snapshot, failing, now),
  };

  return (
    <div className="side:mr-auto side:ml-[max(15rem,calc(50vw-18rem))] side:pt-20 side:pr-8 side:pl-0 docs:mx-auto docs:px-4 mx-auto min-h-screen max-w-(--measure) px-6 pt-8 pb-16">
      <Sidebar
        {...nav}
        onSearch={() => {
          palette.current?.showModal();
        }}
        shortcut={shortcut}
      />
      <Menu {...nav} now={now} onJump={jump} />
      <Search machines={machines} now={now} onJump={jump} ref={palette} />
      <main className="side:pt-0 pt-10">
        <h1 className="text-title side:before:inline-block side:before:h-12 pb-2 before:content-['']">
          Machines
        </h1>
        <p className="text-soft mt-4">
          <strong className="text-ink font-normal">
            {lead(snapshot?.machines ?? null, failing)}
            {snapshot
              ? ` T3 Code answers on ${ready}, and ${linked} ${linked === 1 ? "is" : "are"} linked for agents.`
              : ""}
          </strong>
        </p>
        <p className="text-soft mt-4">
          The hub checks every {snapshot?.history.sampleSeconds ?? 60} seconds
          and keeps the last 24 hours. Each bar under a machine is 30 minutes.
        </p>
        {snapshot && !snapshot.tailscale ? (
          <p className="border-rule rounded-panel text-nav text-soft mt-4 border p-4">
            Tailscale did not answer on the hub machine, so this list holds only
            that machine and its links.
          </p>
        ) : null}

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
              {members.map((machine) => (
                <MachineCard
                  bars={bars(
                    snapshot?.history.states[machine.name] ?? "",
                    snapshot?.history.sampleSeconds ?? 60
                  )}
                  day={daySentences(
                    machine,
                    snapshot?.history.states[machine.name] ?? "",
                    snapshot?.latest.t3 ?? null
                  )}
                  key={machine.name}
                  machine={machine}
                  now={now}
                />
              ))}
            </ul>
          </section>
        ))}
        {snapshot && groups.length === 0 ? (
          <p className="border-rule rounded-panel text-nav text-soft mt-10 border p-4">
            No machine matches this filter.
          </p>
        ) : null}

        <Agents />
      </main>
    </div>
  );
};
