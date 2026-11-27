"use client";

import { Fragment, useEffect, useEffectEvent, useRef, useState } from "react";
import type { KeyboardEvent, PropsWithChildren } from "react";

import { CloseIcon, SearchIcon } from "@/components/icons";
import type { Machine } from "@/lib/machines";
import { morph } from "@/lib/morph";
import { anchorOf, search } from "@/lib/search";
import type { Part } from "@/lib/search";

const Marked = ({ parts }: { parts: readonly Part[] }) =>
  parts.map(({ at, hit, text }) =>
    hit ? <mark key={at}>{text}</mark> : <Fragment key={at}>{text}</Fragment>
  );

const reveal = (item: HTMLAnchorElement | null) => {
  item?.scrollIntoView({ block: "nearest" });
};

const stepOf = (event: KeyboardEvent) => {
  const key = event.key.toLowerCase();

  const chord =
    event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

  if (key === "arrowdown" || (chord && key === "n")) {
    return 1;
  }

  return key === "arrowup" || (chord && key === "p") ? -1 : 0;
};

const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));

const isShown = (element: HTMLElement | null) =>
  element?.checkVisibility({ visibilityProperty: true }) === true;

const useSearchKey = (onAsk: (event: globalThis.KeyboardEvent) => void) => {
  const ask = useEffectEvent(onAsk);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const chord =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";

      if (chord || (event.key === "/" && !isField(event.target))) {
        ask(event);
      }
    };

    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);
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

    const step = stepOf(event);

    if (step !== 0) {
      event.preventDefault();

      if (found.count > 0) {
        setSelected((active + step + found.count) % found.count);
      }
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
 * The search of the Rex docs, over machines instead of pages: a button in the sidebar and the
 * palette it grows into. Ctrl K, Command K or a slash opens it, the arrows move through what it
 * found, and Enter goes to that machine's card.
 */
export const Search = ({
  machines,
  now,
  onJump,
  shortcut,
}: SearchProps & { shortcut: string }) => {
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const close = (animate: boolean) => {
    const panel = dialog.current;
    const button = trigger.current;

    if (panel?.open !== true) {
      return;
    }

    if (animate && button) {
      void morph(panel, button, () => {
        panel.close();
        button.style.visibility = "";
      });
    } else {
      panel.close();
    }
  };

  const open = () => {
    const panel = dialog.current;
    const button = trigger.current;

    if (!panel || !button) {
      return;
    }

    if (panel.open) {
      input.current?.select();

      return;
    }

    const show = () => {
      button.style.visibility = "hidden";
      panel.showModal();
      input.current?.select();
    };

    if (matchMedia("(pointer: coarse)").matches) {
      show();

      return;
    }

    void morph(button, panel, () => {
      panel.dataset.landing = "";
      show();
    }).finally(() => {
      delete panel.dataset.landing;
    });
  };

  const palette = usePalette(machines, now, (name) => {
    close(false);
    onJump(name);
  });

  useSearchKey((event) => {
    if (
      isShown(dialog.current?.open === true ? dialog.current : trigger.current)
    ) {
      event.preventDefault();
      open();
    }
  });

  const dismiss = useEffectEvent((event: MouseEvent) => {
    if (event.target === dialog.current) {
      close(true);
    }
  });

  useEffect(() => {
    const panel = dialog.current;

    panel?.addEventListener("click", dismiss);

    return () => {
      panel?.removeEventListener("click", dismiss);
    };
  }, []);

  return (
    <>
      <button
        className="search-trigger edge text-nav text-muted -ml-3 flex w-[calc(100%+0.75rem)] cursor-pointer items-center gap-2 rounded-full px-2.5 py-1.5 [--fill:var(--paper)]"
        onClick={open}
        ref={trigger}
        type="button"
      >
        <SearchIcon className="size-3.5 shrink-0" />
        Search
        <kbd className="text-muted ml-auto font-sans text-xs">{shortcut}</kbd>
      </button>
      <dialog
        aria-label="Search machines"
        className="search bg-surface text-ink rounded-search mx-auto mt-[12vh] w-[min(32rem,calc(100vw-2rem))] overflow-hidden font-sans"
        onCancel={(event) => {
          event.preventDefault();
          close(true);
        }}
        onClose={() => {
          palette.onQuery("");

          if (trigger.current) {
            trigger.current.style.visibility = "";
            trigger.current.focus({ preventScroll: true });
          }
        }}
        ref={dialog}
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
              ref={input}
              spellCheck={false}
              type="text"
              value={palette.query}
            />
            <button
              aria-label="Close search"
              className="text-muted hover:text-soft cursor-pointer text-[1.1875rem] transition-colors duration-100"
              onClick={() => {
                close(true);
              }}
              type="button"
            >
              esc
            </button>
          </div>
          <Results {...palette} place="dialog" />
        </div>
      </dialog>
    </>
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
  const input = useRef<HTMLInputElement>(null);

  useSearchKey((event) => {
    if (isShown(input.current)) {
      event.preventDefault();
      input.current?.select();
    }
  });

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
          ref={input}
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
