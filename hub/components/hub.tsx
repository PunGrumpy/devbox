"use client";

import { useState, useSyncExternalStore } from "react";

import { CommandPill } from "@/components/copy";
import { HubGlyph } from "@/components/icons";
import { MachineItem } from "@/components/machine-item";
import { ago, bars, FILTERS, headline, summarize } from "@/lib/machines";
import type { FilterKey, Snapshot } from "@/lib/machines";
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

const Field = () => (
  <div
    aria-hidden="true"
    className="gradient-fill pointer-events-none fixed top-3 right-1.5 z-20 h-[calc(100dvh-24px)] w-1.5 overflow-hidden rounded-[14px] sm:right-3 sm:w-14 lg:w-[calc(var(--field)-12px)]"
  >
    <div className="animate-drift absolute -top-1/4 -right-1/4 size-[90%] rounded-full bg-[rgb(209_182_254)] opacity-70 blur-3xl" />
    <div className="animate-drift absolute -bottom-1/4 -left-1/4 size-[80%] rounded-full bg-[rgb(253_147_113)] opacity-60 blur-3xl [animation-delay:-14s]" />
    <div className="field-grain absolute inset-0 opacity-60" />
    <div className="absolute inset-0 rounded-[14px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06),inset_0_1px_0_rgb(255_255_255/0.3)]" />
  </div>
);

const statusText = (
  snapshot: Snapshot | null,
  failing: boolean,
  now: number
) => {
  if (!snapshot) {
    return failing ? "The hub is not answering" : "Checking";
  }

  const checked = ago(snapshot.generatedAt, now);

  return failing ? `Not answering · checked ${checked}` : `Checked ${checked}`;
};

interface MachinesProps {
  filter: FilterKey;
  now: number;
  onFilter: (filter: FilterKey) => void;
  snapshot: Snapshot | null;
}

const Machines = ({ filter, now, onFilter, snapshot }: MachinesProps) => {
  const machines = snapshot?.machines ?? [];
  const test = FILTERS.find((candidate) => candidate.key === filter)?.test;
  const shown = machines.filter((machine) => test?.(machine) ?? true).length;

  return (
    <section
      aria-labelledby="machines-title"
      className="my-10 max-w-[72ch] md:my-14"
    >
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="text-muted" id="machines-title">
          Machines
        </h2>
        <nav
          aria-label="Filter machines"
          className="flex flex-wrap gap-x-5 gap-y-1"
        >
          {FILTERS.map(({ key, label, test: matches }) => (
            <button
              aria-pressed={key === filter}
              className="text-muted hover:text-ink aria-pressed:text-ink ease-press cursor-pointer transition-[color,transform] duration-150 active:scale-[0.97]"
              key={key}
              onClick={() => {
                onFilter(key);
              }}
              type="button"
            >
              {label}{" "}
              <span className="tabular-nums">
                {machines.filter(matches).length}
              </span>
            </button>
          ))}
        </nav>
      </div>
      {snapshot && !snapshot.tailscale ? (
        <p className="text-muted mb-6">
          Tailscale did not answer on the hub machine, so this list holds only
          that machine and its links.
        </p>
      ) : null}
      <ol>
        {machines.map((machine, index) => (
          <MachineItem
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
      </ol>
      {snapshot && shown === 0 ? (
        <p className="text-muted">No machine matches this filter.</p>
      ) : null}
    </section>
  );
};

const Agents = () => {
  const origin = useSyncExternalStore(subscribe, getOrigin, getServerOrigin);

  return (
    <section
      aria-labelledby="agents-title"
      className="my-10 max-w-[72ch] md:my-14"
    >
      <h2 className="text-muted mb-4" id="agents-title">
        For agents
      </h2>
      <div className="flex flex-col gap-5">
        <p>
          The same list is available as JSON. An agent reads it before it picks
          a machine, then reaches a linked one by its environment id.
        </p>
        <div className="flex flex-col gap-2">
          <CommandPill text="devbox machines --json" />
          <CommandPill text={`curl -s ${origin}/api/machines`} />
        </div>
      </div>
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
  const { accent, lead } = headline(snapshot?.machines ?? null, failing);
  const { linked, ready } = summarize(snapshot?.machines ?? []);

  return (
    <div className="min-h-dvh">
      <Field />
      <div className="relative z-10 my-8 flex flex-col px-6 pr-9 sm:my-10 sm:px-10 sm:pr-[calc(80px+2.5rem)] lg:my-12 lg:px-16 lg:pr-[calc(var(--field)+4rem)]">
        <header className="animate-rise flex h-6 items-center justify-between gap-6">
          <span className="flex items-center gap-3 font-medium">
            <HubGlyph className="size-6" />
            devbox hub
          </span>
          <output
            className={`text-caption truncate tabular-nums transition-colors duration-200 ${failing ? "text-ink" : "text-muted"}`}
          >
            {statusText(snapshot, failing, now)}
          </output>
        </header>

        <h1 className="text-h1 animate-rise mt-24 mb-12 max-w-[18ch] font-medium text-balance [animation-delay:40ms] md:mt-36 md:mb-16">
          {lead} <span className="gradient-text">{accent}</span>
        </h1>

        <button
          className="border-rule/60 hover:border-rule ease-press animate-rise flex max-w-[72ch] cursor-pointer items-center gap-4 rounded-[28px] border p-4 pr-6 text-left transition-[border-color,background-color,transform] duration-150 [animation-delay:80ms] hover:bg-white/25 active:scale-[0.99] dark:hover:bg-white/5"
          onClick={() => {
            void refresh();
          }}
          type="button"
        >
          <HubGlyph className="size-14 shrink-0 drop-shadow-[0_10px_12px_rgb(0_0_0/0.08)]" />
          <span className="flex flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span>
              T3 Code answers on {ready}. {linked} linked for agents.
            </span>
            <span className="gradient-text shrink-0">Check again</span>
          </span>
        </button>

        <Machines
          filter={filter}
          now={now}
          onFilter={setFilter}
          snapshot={snapshot}
        />
        <Agents />

        <footer className="text-caption text-muted mt-6 mb-4 max-w-[72ch]">
          The hub checks every {snapshot?.history.sampleSeconds ?? 60} seconds
          and keeps the last 24 hours in memory. Each bar is 30 minutes.
        </footer>
      </div>
    </div>
  );
};
