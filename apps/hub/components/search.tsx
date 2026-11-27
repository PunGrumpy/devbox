"use client";

import { Fragment, useEffect, useState } from "react";
import type { KeyboardEvent, PropsWithChildren, RefObject } from "react";

import { CloseIcon, SearchIcon } from "@/components/icons";
import type { Machine } from "@/lib/machines";
import { anchorOf, search } from "@/lib/search";
import type { Part } from "@/lib/search";

const Marked = ({ parts }: { parts: readonly Part[] }) =>
  parts.map(({ at, hit, text }) =>
    hit ? <mark key={at}>{text}</mark> : <Fragment key={at}>{text}</Fragment>
  );

const reveal = (item: HTMLAnchorElement | null) => {
  item?.scrollIntoView({ block: "nearest" });
};

const usePalette = (
  machines: readonly Machine[],
  now: number,
  onPick: (name: string) => void
) => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const found = search(machines, query, now);
  const active = Math.min(selected, Math.max(found.count - 1, 0));

  const pick = (name: string) => {
    setQuery("");
    setSelected(0);
    onPick(name);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }

    const hit = found.groups
      .flatMap(({ hits }) => hits)
      .find(({ index }) => index === active);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(Math.min(active + 1, found.count - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(Math.max(active - 1, 0));
    } else if (event.key === "Enter" && hit !== undefined) {
      event.preventDefault();
      pick(hit.machine.name);
    }
  };

  return {
    active,
    found,
    handleKeyDown,
    query,
    onPick: pick,
    onQuery: (value: string) => {
      setQuery(value);
      setSelected(0);
    },
    onSelect: setSelected,
  };
};

const PLACES = {
  dialog: {
    excerpt: "text-[0.8125rem]",
    label: "text-xs",
    list: "search-results border-rule overflow-y-auto overscroll-contain border-t px-2 pt-1 pb-2",
    none: "border-rule text-nav border-t px-4 py-10 text-center",
    title: "text-[0.9375rem]",
  },
  menu: {
    excerpt: "text-[0.9375rem]",
    label: "text-nav",
    list: "",
    none: "text-body px-3 pt-6",
    title: "text-[1.0625rem]",
  },
};

type ResultsProps = Pick<
  ReturnType<typeof usePalette>,
  "active" | "found" | "onPick" | "onSelect" | "query"
> & { place: keyof typeof PLACES };

const Results = ({
  active,
  found,
  onPick,
  onSelect,
  place,
  query,
}: ResultsProps) => {
  const classes = PLACES[place];

  if (query.trim() === "") {
    return null;
  }

  if (found.count === 0) {
    return (
      <p className={`text-soft ${classes.none}`}>
        No results for “<span className="text-ink">{query}</span>”
      </p>
    );
  }

  return (
    <div className={classes.list}>
      {found.groups.map(({ hits, key, label }) => (
        <div key={key}>
          <p className={`text-muted px-3 pt-3 pb-1.5 ${classes.label}`}>
            {label}
          </p>
          <ul>
            {hits.map(({ excerpt, index, machine, title }) => (
              <li key={machine.name}>
                <a
                  aria-current={index === active ? "true" : undefined}
                  className="group rounded-panel aria-[current=true]:bg-hover flex items-start gap-3 px-3 py-2.5"
                  href={`#${anchorOf(machine.name)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onPick(machine.name);
                  }}
                  onPointerMove={() => {
                    onSelect(index);
                  }}
                  ref={index === active ? reveal : undefined}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`search-title block truncate leading-snug tracking-[-0.01em] ${classes.title}`}
                    >
                      <Marked parts={title} />
                    </span>
                    <span
                      className={`text-soft line-clamp-2 pt-0.5 leading-[1.45] ${classes.excerpt}`}
                    >
                      <Marked parts={excerpt} />
                    </span>
                  </span>
                  {place === "dialog" ? (
                    <span
                      aria-hidden="true"
                      className="text-muted mt-1.5 shrink-0 text-xs opacity-0 group-aria-[current=true]:opacity-100"
                    >
                      ↵
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};

interface SearchProps {
  machines: readonly Machine[];
  now: number;
  onJump: (name: string) => void;
}

/**
 * The search palette of the Rex docs, over machines instead of pages. Ctrl K or Command K opens
 * it, the arrows move through what it found, and Enter goes to that machine's card.
 */
export const Search = ({
  machines,
  now,
  onJump,
  ref,
}: SearchProps & { ref: RefObject<HTMLDialogElement | null> }) => {
  const palette = usePalette(machines, now, (name) => {
    ref.current?.close();
    onJump(name);
  });

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "k" ||
        !(event.metaKey || event.ctrlKey)
      ) {
        return;
      }

      event.preventDefault();

      if (ref.current?.open === true) {
        ref.current.close();
      } else {
        ref.current?.showModal();
      }
    };

    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [ref]);

  return (
    <dialog
      aria-label="Search machines"
      className="search bg-surface text-ink rounded-search mx-auto mt-[12vh] w-[min(32rem,calc(100vw-2rem))] overflow-hidden font-sans"
      closedby="any"
      onClose={() => {
        palette.onQuery("");
      }}
      ref={ref}
    >
      <div className="flex max-h-[min(36rem,76vh)] flex-col">
        <div className="flex items-center gap-[0.8125rem] px-[1.0625rem]">
          <SearchIcon className="text-muted size-5.5 shrink-0" />
          <input
            aria-label="Search machines"
            autoComplete="off"
            className="placeholder:text-muted caret-accent h-12 min-w-0 flex-1 bg-transparent text-[1.375rem] tracking-[-0.01em] outline-none"
            onChange={(event) => {
              palette.onQuery(event.target.value);
            }}
            onKeyDown={palette.handleKeyDown}
            placeholder="Search"
            spellCheck={false}
            type="text"
            value={palette.query}
          />
          <button
            aria-label="Close search"
            className="text-muted hover:text-soft cursor-pointer text-[1.1875rem] transition-colors duration-100"
            onClick={() => {
              ref.current?.close();
            }}
            type="button"
          >
            esc
          </button>
        </div>
        <Results {...palette} place="dialog" />
      </div>
    </dialog>
  );
};

/**
 * The same search as a field at the top of the menu, the way the docs set it on a narrow screen:
 * what it finds takes the place of the navigation below it.
 */
export const MenuSearch = ({
  children,
  machines,
  now,
  onJump,
}: PropsWithChildren<SearchProps>) => {
  const palette = usePalette(machines, now, onJump);

  const searching = palette.query.trim() !== "";

  return (
    <div className="[--hover:color-mix(in_srgb,var(--accent)_8%,var(--paper))]">
      <label className="edge -ml-3 flex h-11 w-[calc(100%+0.75rem)] cursor-text items-center gap-2.5 rounded-full pr-1 pl-2.5 [--fill:var(--paper)] focus-within:[--fill:var(--surface)]">
        <SearchIcon className="text-muted size-4 shrink-0" />
        <input
          aria-label="Search machines"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="text-ink placeholder:text-muted caret-accent min-w-0 flex-1 self-stretch bg-transparent text-[1.0625rem] tracking-[-0.01em] outline-none"
          enterKeyHint="go"
          onChange={(event) => {
            palette.onQuery(event.target.value);
          }}
          onKeyDown={palette.handleKeyDown}
          placeholder="Search"
          spellCheck={false}
          type="text"
          value={palette.query}
        />
        {searching ? (
          <button
            aria-label="Clear search"
            className="text-muted grid size-9 shrink-0 cursor-pointer place-items-center rounded-full"
            onClick={() => {
              palette.onQuery("");
            }}
            type="button"
          >
            <CloseIcon className="size-4" />
          </button>
        ) : null}
      </label>
      {searching ? (
        <div className="-mx-3 pt-3">
          <Results {...palette} place="menu" />
        </div>
      ) : null}
      <div className="pt-9" hidden={searching}>
        {children}
      </div>
    </div>
  );
};
