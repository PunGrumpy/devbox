import type { PropsWithChildren } from "react";

import { CopyText } from "@/components/copy";
import { ArrowIcon } from "@/components/icons";
import { Strip } from "@/components/strip";
import { linkText, span, stateText, whereDetail } from "@/lib/machines";
import type { BarState, Machine, MachineState } from "@/lib/machines";

const STAGGER_MS = 30;
const STAGGER_ROWS = 8;

const DOT_CLASS = {
  offline: "border-muted border-[1.5px]",
  online: "bg-soft",
  t3: "bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)]",
} satisfies Record<MachineState, string>;

interface CellProps extends PropsWithChildren {
  className?: string;
  label: string;
}

const Cell = ({ children, className = "", label }: CellProps) => (
  <div className={`min-w-0 ${className}`}>
    <span className="text-detail text-muted mb-1 block lg:hidden">{label}</span>
    {children}
  </div>
);

const Detail = ({
  children,
  className = "",
}: PropsWithChildren<{ className?: string }>) => (
  <span
    className={`text-detail text-soft mt-0.5 block truncate tabular-nums ${className}`}
  >
    {children}
  </span>
);

const Where = ({ machine }: { machine: Machine }) => (
  <Cell className="col-span-2 lg:col-span-1" label="Where">
    {machine.tailscale ? (
      <CopyText text={machine.tailscale.dns} />
    ) : (
      <span className="text-muted">Not on the tailnet</span>
    )}
    <Detail className="font-mono">{whereDetail(machine)}</Detail>
  </Cell>
);

const T3Name = ({ t3 }: { t3: Machine["t3"] }) => {
  if (!t3) {
    return <span className="text-muted">Not found</span>;
  }

  if (t3.url === null) {
    return <span className="block truncate">{t3.label}</span>;
  }

  return (
    <a
      className="group/open decoration-faint inline-flex max-w-full items-center gap-1 underline-offset-4 hover:underline"
      href={t3.url}
      rel="noreferrer"
      target="_blank"
    >
      <span className="truncate">{t3.label}</span>
      <ArrowIcon className="text-muted group-hover/open:text-ink ease-press shrink-0 transition-[color,transform] duration-150 group-hover/open:translate-x-px group-hover/open:-translate-y-px" />
    </a>
  );
};

interface MachineRowProps {
  bars: readonly BarState[];
  hidden: boolean;
  index: number;
  machine: Machine;
  now: number;
}

export const MachineRow = ({
  bars,
  hidden,
  index,
  machine,
  now,
}: MachineRowProps) => {
  const link = machine.t3?.link;
  const version = machine.t3?.version ?? null;

  return (
    <li
      className="border-rule hover:bg-hover animate-rise grid grid-cols-2 gap-x-6 gap-y-3 border-t px-5 py-3.5 transition-colors duration-100 lg:grid-cols-(--cols) lg:items-center"
      hidden={hidden}
      style={{
        animationDelay: `${Math.min(index, STAGGER_ROWS) * STAGGER_MS}ms`,
      }}
    >
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`size-2 shrink-0 rounded-full transition-colors duration-200 ${DOT_CLASS[machine.state]}`}
          />
          <span
            className={`truncate ${machine.state === "offline" ? "text-soft" : ""}`}
          >
            {machine.name}
          </span>
          {machine.here ? (
            <span className="bg-wash text-soft shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none">
              here
            </span>
          ) : null}
        </div>
        <Detail className="pl-[1.125rem]">
          {machine.tailscale ? machine.tailscale.os : "linked by URL"}
        </Detail>
      </div>

      <Where machine={machine} />

      <Cell label="T3 Code">
        <T3Name t3={machine.t3} />
        {version === null ? null : (
          <Detail className="font-mono">{version}</Detail>
        )}
      </Cell>

      <Cell label="Agent link">
        <span className={link ? "" : "text-muted"}>{linkText(link)}</span>
        {link ? (
          <Detail>
            {link.access} · {span(Date.parse(link.expiresAt) - now)} left
          </Detail>
        ) : null}
      </Cell>

      <div className="col-span-2 min-w-0 lg:col-span-1">
        <Strip bars={bars} />
        <Detail
          className={`lg:text-right ${machine.state === "t3" ? "text-ink" : ""}`}
        >
          {stateText(machine, now)}
        </Detail>
      </div>
    </li>
  );
};
