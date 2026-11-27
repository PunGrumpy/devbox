"use client";

import { useEffect, useState } from "react";

import { HubLogo } from "@/components/icons";
import { MenuSearch } from "@/components/search";
import { Nav } from "@/components/sidebar";
import type { NavProps } from "@/components/sidebar";

interface MenuProps extends NavProps {
  now: number;
  onJump: (name: string) => void;
  onRefresh: () => void;
  onSignOut: () => void;
  status: string;
}

/**
 * What a narrow screen gets in place of the sidebar, as in the Rex docs: the icon, a two-bar
 * button, and a sheet that slides over the page with the same navigation set large.
 */
export const Menu = ({
  now,
  onJump,
  onRefresh,
  onSignOut,
  status,
  ...nav
}: MenuProps) => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <>
      <header className="side:hidden flex h-12 items-center justify-between">
        <HubLogo className="size-12" />
        <button
          aria-controls="menu"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          className="menu-toggle bg-paper fixed top-9 right-[max(1rem,calc(50%-var(--measure)/2+1rem))] z-50 flex size-10 cursor-pointer items-center justify-center rounded-full"
          onClick={() => {
            setOpen(!open);
          }}
          type="button"
        >
          <svg
            aria-hidden="true"
            fill="none"
            height="20"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.5"
            viewBox="0 0 20 20"
            width="20"
          >
            <path className="bar-top" d="M3.5 7.25h13" />
            <path className="bar-bottom" d="M3.5 12.75h13" />
          </svg>
        </button>
      </header>
      <div
        className="menu side:hidden bg-paper fixed inset-0 z-40"
        data-open={open ? "" : undefined}
        id="menu"
        inert={!open}
      >
        <HubLogo className="absolute top-8 left-[max(1.5rem,calc(50%-var(--measure)/2+1.5rem))] size-12" />
        <div className="menu-scroll absolute inset-0 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-[38rem] px-6 pt-[6.75rem] pb-16">
            <MenuSearch
              machines={nav.machines}
              now={now}
              onJump={(name) => {
                setOpen(false);
                onJump(name);
              }}
            >
              <nav
                aria-label="Machines"
                className="text-menu flex flex-col gap-9"
              >
                <Nav
                  {...nav}
                  onNavigate={() => {
                    setOpen(false);
                  }}
                />
              </nav>
              <div className="flex flex-col items-start gap-3 pt-8">
                <button
                  className="text-menu text-soft hover:text-ink cursor-pointer text-left tabular-nums transition-colors duration-100"
                  onClick={onRefresh}
                  type="button"
                >
                  {status}
                </button>
                <button
                  className="text-menu text-muted hover:text-ink cursor-pointer text-left transition-colors duration-100"
                  onClick={() => {
                    setOpen(false);
                    onSignOut();
                  }}
                  type="button"
                >
                  Sign out
                </button>
              </div>
            </MenuSearch>
          </div>
        </div>
      </div>
    </>
  );
};
