"use client";

import { useSyncExternalStore } from "react";

import { CopyButton } from "@/components/copy";
import { span, summarize } from "@/lib/machines";
import type { Machine } from "@/lib/machines";
import { subscribe } from "@/lib/store";

const FALLBACK_ORIGIN = "http://127.0.0.1:3780";

const getOrigin = () => window.location.origin;
const getServerOrigin = () => FALLBACK_ORIGIN;

interface StatProps {
  detail?: string;
  term: string;
  value: string;
}

const Stat = ({ detail, term, value }: StatProps) => (
  <div className="min-w-0">
    <dt className="text-detail text-soft">{term}</dt>
    <dd className="mt-0.5 truncate tabular-nums">
      {value}
      {detail === undefined ? null : (
        <span className="text-soft"> {detail}</span>
      )}
    </dd>
  </div>
);

interface SummaryPaneProps {
  machines: readonly Machine[];
  now: number;
}

export const SummaryPane = ({ machines, now }: SummaryPaneProps) => {
  const { linked, nextExpiry, online, ready, slowest, total } =
    summarize(machines);

  return (
    <section
      aria-label="Summary"
      className="pane flex flex-col justify-between gap-6 p-5"
    >
      <p className="flex items-baseline gap-2.5">
        <span className="text-display tabular-nums">{online}</span>
        <span className="text-soft">of {total} online</span>
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat term="T3 Code" value={`${ready} ready`} />
        <Stat term="Linked for agents" value={String(linked)} />
        <Stat
          detail={nextExpiry?.name}
          term="Next link to renew"
          value={nextExpiry ? `in ${span(nextExpiry.expiresAt - now)}` : "None"}
        />
        <Stat
          detail={slowest?.name}
          term="Slowest answer"
          value={slowest ? `${Math.round(slowest.latencyMs)} ms` : "None"}
        />
      </dl>
    </section>
  );
};

const Snippet = ({ command }: { command: string }) => (
  <div className="bg-wash text-detail flex h-9 min-w-0 items-center gap-2 rounded-lg pr-1 pl-3 font-mono">
    <span aria-hidden="true" className="text-muted select-none">
      $
    </span>
    <code className="min-w-0 flex-1 truncate">{command}</code>
    <CopyButton text={command} />
  </div>
);

export const AgentsPane = () => {
  const origin = useSyncExternalStore(subscribe, getOrigin, getServerOrigin);

  return (
    <section
      aria-labelledby="agents-title"
      className="pane flex flex-col justify-between gap-5 p-5"
    >
      <div>
        <h2 className="text-heading" id="agents-title">
          For agents
        </h2>
        <p className="text-nav text-soft mt-1.5 max-w-[52ch] leading-normal">
          The same list as JSON. An agent reads it before it picks a machine,
          then reaches a linked one by its{" "}
          <code className="bg-wash rounded px-1 py-px font-mono text-[0.8125em]">
            environmentId
          </code>
          .
        </p>
      </div>
      <div className="grid gap-1.5">
        <Snippet command="devbox machines --json" />
        <Snippet command={`curl -s ${origin}/api/machines`} />
      </div>
    </section>
  );
};
