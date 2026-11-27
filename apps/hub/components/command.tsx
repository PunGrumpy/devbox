"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { useCopied } from "@/components/copy";
import { CopyIcon } from "@/components/icons";
import { shine } from "@/lib/sheen";
import { shellTokens } from "@/lib/shell";
import type { TokenKind } from "@/lib/shell";

const TOKEN_CLASS = {
  function: "text-code-function",
  operator: "text-code-operator",
  plain: "",
  property: "text-code-property",
} satisfies Record<TokenKind, string>;

interface Fit {
  height: number;
  overflowing: boolean;
}

const fitOf = (code: HTMLElement) =>
  ({
    height: code.offsetHeight,
    overflowing: code.scrollLeft + code.clientWidth < code.scrollWidth - 1,
  }) satisfies Fit;

interface CommandProps {
  selected: number;
  texts: readonly string[];
}

const Command = ({ selected, texts }: CommandProps) => {
  const text = texts[selected] ?? "";
  const { copied, copy } = useCopied(text);
  const overlay = useRef<HTMLSpanElement>(null);
  const [code, setCode] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState<Fit | null>(null);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry?.target instanceof HTMLElement) {
        setFit(fitOf(entry.target));
      }
    });

    if (code) {
      observer.observe(code);
    }

    return () => {
      observer.disconnect();
    };
  }, [code]);

  const handleCopy = async () => {
    await copy();

    if (overlay.current) {
      shine(overlay.current);
    }
  };

  return (
    <div className="relative mt-4">
      <pre className="edge squircle rounded-panel text-soft overflow-x-hidden py-[calc(0.625rem-1px)] pr-12 pl-[calc(1rem-1px)]">
        <span
          className="command-stack grid overflow-y-clip"
          style={{ height: fit?.height }}
        >
          {texts.map((line, index) => {
            const active = index === selected;

            return (
              <code
                className={`col-start-1 row-start-1 block [scrollbar-width:none] self-start overflow-x-auto font-mono text-[0.875em] leading-[calc(1.5em/0.875)] transition-opacity ease-linear ${active ? "delay-50 duration-250" : "pointer-events-none opacity-0 duration-150"} ${active && fit?.overflowing === true ? "mask-[linear-gradient(to_right,black_calc(100%-2rem),transparent)]" : ""}`}
                inert={!active}
                key={line}
                onScroll={(event) => {
                  setFit(fitOf(event.currentTarget));
                }}
                ref={active ? setCode : undefined}
              >
                {shellTokens(line).map(({ at, kind, text: piece }) => (
                  <span className={TOKEN_CLASS[kind]} key={at}>
                    {piece}
                  </span>
                ))}
              </code>
            );
          })}
        </span>
      </pre>
      <div className="absolute top-2 right-2">
        <button
          aria-label={copied ? "Copied" : "Copy command"}
          className="rounded-panel text-muted hover:text-ink grid size-7 shrink-0 cursor-pointer place-items-center transition-colors duration-100"
          onClick={() => {
            void handleCopy();
          }}
          type="button"
        >
          <CopyIcon className="size-4" copied={copied} />
        </button>
      </div>
      <span aria-hidden="true" className="sheen" ref={overlay}>
        <span className="sheen-band" />
        <span className="sheen-edge" />
      </span>
    </div>
  );
};

interface Pill {
  instant: boolean;
  left: number;
  width: number;
}

const tabAfter = (key: string, at: number, count: number) => {
  if (key === "ArrowRight") {
    return (at + 1) % count;
  }

  if (key === "ArrowLeft") {
    return (at - 1 + count) % count;
  }

  if (key === "Home") {
    return 0;
  }

  return key === "End" ? count - 1 : undefined;
};

export interface CommandTab {
  label: string;
  /** A sentence above the tabs that changes with the selected one. */
  lead?: string;
  text: string;
}

/**
 * The same command in more than one form, as the Rex docs offer it: a row of tabs with a pill that
 * travels to the selected one, over a panel with the program and its flags in colour and a button
 * that copies. A change of tab fades one command out and the next in. A command too long for the
 * panel scrolls sideways and fades at the right edge.
 */
export const CommandTabs = ({ items }: { items: readonly CommandTab[] }) => {
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [selected, setSelected] = useState(0);
  const [pill, setPill] = useState<Pill | null>(null);

  useEffect(() => {
    let settled = false;

    const observer = new ResizeObserver(() => {
      const tab = tabs.current[selected];

      if (tab) {
        setPill({
          instant: settled,
          left: tab.offsetLeft,
          width: tab.offsetWidth,
        });
        settled = true;
      }
    });

    for (const tab of tabs.current) {
      if (tab) {
        observer.observe(tab);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [selected]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = tabAfter(event.key, selected, items.length);

    if (next !== undefined) {
      event.preventDefault();
      setSelected(next);
      tabs.current[next]?.focus();
    }
  };

  const lead = items[selected]?.lead;

  return (
    <div className="mt-4">
      {lead === undefined ? null : (
        <p aria-live="polite" className="text-soft mb-4">
          {lead}
        </p>
      )}
      <div
        className="text-nav relative -mx-1 flex [scrollbar-width:none] gap-1 overflow-x-auto px-1"
        role="tablist"
      >
        {pill ? (
          <span
            aria-hidden="true"
            className={`bg-wash absolute inset-y-0 left-0 rounded-full ${pill.instant ? "" : "ease-spring transition-[transform,width] duration-250"}`}
            style={{
              transform: `translateX(${pill.left}px)`,
              width: pill.width,
            }}
          />
        ) : null}
        {items.map(({ label }, index) => {
          const active = index === selected;

          return (
            <button
              aria-controls={`${id}-panel`}
              aria-selected={active}
              className={`hover:text-ink relative shrink-0 cursor-pointer rounded-full px-3 py-1.5 whitespace-nowrap transition-colors duration-100 ${active ? "text-ink" : "text-soft"} ${active && !pill ? "bg-wash" : ""}`}
              id={`${id}-tab-${index}`}
              key={label}
              onClick={() => {
                setSelected(index);
              }}
              onKeyDown={handleKeyDown}
              ref={(tab) => {
                tabs.current[index] = tab;
              }}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              {label}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`${id}-tab-${selected}`}
        className="-mt-2"
        id={`${id}-panel`}
        role="tabpanel"
      >
        <Command selected={selected} texts={items.map(({ text }) => text)} />
      </div>
    </div>
  );
};
