"use client";

import { useState, useSyncExternalStore } from "react";

import { CodeBlock } from "@/components/copy";
import { Field } from "@/components/field";
import { HubGlyph, OsIcon } from "@/components/icons";
import { MachineCard } from "@/components/machine-card";
import { Filters, Sidebar } from "@/components/sidebar";
import { ago, bars, FILTERS, groupByOs, lead, summarize } from "@/lib/machines";
import type { FilterKey, Machine, Snapshot } from "@/lib/machines";
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

const matching = (
  machines: readonly Machine[],
  filter: FilterKey,
  query: string
) => {
  const test = FILTERS.find((candidate) => candidate.key === filter)?.test;
  const needle = query.trim().toLowerCase();

  return machines.filter(
    (machine) =>
      (test?.(machine) ?? true) && machine.name.toLowerCase().includes(needle)
  );
};

const Agents = () => {
  const origin = useSyncExternalStore(subscribe, getOrigin, getServerOrigin);

  return (
    <section>
      <h2 className="text-heading scroll-mt-10 pt-10" id="agents">
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
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const machines = snapshot?.machines ?? [];
  const groups = groupByOs(matching(machines, filter, query));
  const { linked, ready } = summarize(machines);
  const status = statusText(snapshot, failing, now);

  return (
    <>
      <Field />
      <Sidebar
        filter={filter}
        machines={machines}
        onFilter={setFilter}
        onQuery={setQuery}
        onRefresh={() => {
          void refresh();
        }}
        query={query}
        sections={groups}
        status={status}
      />
      <main className="side:px-0 side:pt-20 mx-auto w-full max-w-xl px-6 pt-10 pb-24">
        <div className="side:hidden text-nav text-soft mb-10 flex items-center justify-between gap-4">
          <HubGlyph className="size-9 rounded-(--radius-icon)" />
          <output className="truncate tabular-nums">{status}</output>
        </div>
        <h1 className="text-title min-h-[63px] pb-2">Machines</h1>
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
          and keeps the last 24 hours in memory. Each bar under a machine is 30
          minutes.
        </p>
        {snapshot && !snapshot.tailscale ? (
          <p className="border-rule rounded-panel text-nav text-soft mt-4 border p-4">
            Tailscale did not answer on the hub machine, so this list holds only
            that machine and its links.
          </p>
        ) : null}
        <div className="side:hidden text-nav mt-6">
          <Filters filter={filter} machines={machines} onFilter={setFilter} />
        </div>

        {groups.map(({ key, label, machines: members }) => (
          <section key={key}>
            <h2
              className="text-heading flex scroll-mt-10 items-center pt-10"
              id={key}
            >
              <OsIcon
                className="-mt-0.5 mr-1.5 size-[22px] shrink-0"
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
    </>
  );
};
