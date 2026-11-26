"use client";

import { useState, useSyncExternalStore } from "react";

import { HubGlyph, RefreshIcon } from "@/components/icons";
import { MachineRow } from "@/components/machine-row";
import { AgentsPane, SummaryPane } from "@/components/panes";
import { ago, bars, FILTERS } from "@/lib/machines";
import type { FilterKey, Snapshot } from "@/lib/machines";
import {
  getHubState,
  getNow,
  getServerHubState,
  getServerNow,
  refresh,
  subscribe,
} from "@/lib/store";

const COLUMNS =
  "[--cols:minmax(9.5rem,1fr)_minmax(13.5rem,1.6fr)_minmax(8.5rem,1.1fr)_minmax(9rem,0.95fr)_12rem]";

const statusText = (
  snapshot: Snapshot | null,
  failing: boolean,
  now: number
) => {
  if (!snapshot) {
    return failing ? "The hub is not answering" : "Checking";
  }

  const checked = `checked ${ago(snapshot.generatedAt, now)}`;

  return failing
    ? `The hub is not answering · ${checked}`
    : `C${checked.slice(1)}`;
};

interface MachinesPaneProps {
  filter: FilterKey;
  now: number;
  snapshot: Snapshot | null;
}

const MachinesPane = ({ filter, now, snapshot }: MachinesPaneProps) => {
  const machines = snapshot?.machines ?? [];
  const test = FILTERS.find((candidate) => candidate.key === filter)?.test;
  const shown = machines.filter((machine) => test?.(machine) ?? true).length;

  return (
    <section
      aria-label="Machines"
      className={`pane flex min-w-0 flex-col overflow-hidden sm:col-span-2 ${COLUMNS}`}
    >
      {snapshot && !snapshot.tailscale ? (
        <p className="bg-wash text-nav text-soft m-3 mb-0 rounded-lg px-3 py-2.5">
          Tailscale did not answer on the hub machine, so this list holds only
          that machine and its links.
        </p>
      ) : null}
      <div
        aria-hidden="true"
        className="text-detail text-soft hidden grid-cols-(--cols) gap-x-6 px-5 pt-3.5 pb-3 lg:grid"
      >
        <span>Machine</span>
        <span>Where</span>
        <span>T3 Code</span>
        <span>Agent link</span>
        <span className="text-right">Last 24 h</span>
      </div>
      <ul className="flex-1">
        {machines.map((machine, index) => (
          <MachineRow
            bars={bars(
              snapshot?.history.states[machine.name] ?? "",
              snapshot?.history.sampleSeconds ?? 60
            )}
            hidden={!(test?.(machine) ?? true)}
            index={index}
            key={machine.name}
            machine={machine}
            now={now}
          />
        ))}
      </ul>
      {shown === 0 ? (
        <p className="border-rule text-soft border-t px-5 py-8">
          {snapshot
            ? "No machine matches this filter."
            : "Asking the hub for its machines."}
        </p>
      ) : null}
      <footer className="border-rule text-muted flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t px-5 py-2.5 font-mono text-xs">
        <span>devbox hub</span>
        <span>
          {snapshot?.history.sampleSeconds ?? 60}s checks · 30 min per bar · 24
          h in memory
        </span>
      </footer>
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
  const [filter, setFilter] = useState<FilterKey>("all");
  const [turns, setTurns] = useState(0);
  const machines = snapshot?.machines ?? [];

  return (
    <div className="mx-auto flex min-h-dvh max-w-[88rem] flex-col gap-2 p-2 sm:p-3">
      <header className="flex h-10 items-center gap-1 pr-0.5 pl-1.5">
        <h1 className="text-nav mr-3 flex shrink-0 items-center gap-2.5">
          <HubGlyph />
          hub
        </h1>
        <nav
          aria-label="Filter machines"
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {FILTERS.map(({ key, label, test }) => (
            <button
              aria-pressed={key === filter}
              className="text-nav text-soft hover:text-ink aria-pressed:bg-wash aria-pressed:text-ink ease-press flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 transition-[color,background-color,transform] duration-150 active:scale-[0.97]"
              key={key}
              onClick={() => {
                setFilter(key);
              }}
              type="button"
            >
              {label}
              <span className="text-muted tabular-nums">
                {machines.filter(test).length}
              </span>
            </button>
          ))}
        </nav>
        <output
          className={`text-detail ml-auto hidden truncate pl-3 tabular-nums transition-colors duration-200 sm:block ${failing ? "text-accent" : "text-soft"}`}
        >
          {statusText(snapshot, failing, now)}
        </output>
        <button
          aria-label="Refresh"
          className="text-soft hover:text-ink hover:bg-wash ease-press ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-full transition-[color,background-color,transform] duration-150 active:scale-[0.94] sm:ml-1"
          onClick={() => {
            setTurns((count) => count + 1);
            void refresh();
          }}
          type="button"
        >
          <RefreshIcon
            className={turns > 0 ? "animate-turn" : undefined}
            key={turns}
          />
        </button>
      </header>

      <main className="grid flex-1 content-start gap-2 sm:grid-cols-2">
        <SummaryPane machines={machines} now={now} />
        <AgentsPane />
        <MachinesPane filter={filter} now={now} snapshot={snapshot} />
      </main>
    </div>
  );
};
