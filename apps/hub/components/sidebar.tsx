import { HubLogo } from "@/components/icons";
import { Search } from "@/components/search";
import { FILTERS } from "@/lib/machines";
import type { FilterKey, Machine } from "@/lib/machines";

export interface NavProps {
  filter: FilterKey;
  machines: readonly Machine[];
  onFilter: (filter: FilterKey) => void;
  onNavigate?: () => void;
  sections: readonly { key: string; label: string }[];
}

export const Nav = ({
  filter,
  machines,
  onFilter,
  onNavigate,
  sections,
}: NavProps) => (
  <>
    <div>
      <ul>
        {FILTERS.map(({ key, label, test }) => (
          <li key={key}>
            <button
              aria-pressed={key === filter}
              className="nav-link text-soft aria-pressed:text-ink"
              onClick={() => {
                onFilter(key);
                onNavigate?.();
              }}
              type="button"
            >
              {label}{" "}
              <span className="text-muted tabular-nums">
                {machines.filter(test).length}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
    <div>
      <h2 className="text-muted pb-3">On this page</h2>
      <ul>
        {[
          ...sections,
          { key: "agents", label: "For agents" },
          { key: "settings", label: "Settings" },
        ].map(({ key, label }) => (
          <li key={key}>
            <a
              className="nav-link text-soft"
              href={`#${key}`}
              onClick={onNavigate}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  </>
);

interface SidebarProps extends NavProps {
  now: number;
  onJump: (name: string) => void;
  onRefresh: () => void;
  onSignOut: () => void;
  shortcut: string;
  status: string;
}

export const Sidebar = ({
  now,
  onJump,
  onRefresh,
  onSignOut,
  shortcut,
  status,
  ...nav
}: SidebarProps) => (
  <aside className="max-side:hidden side:fixed side:top-0 side:left-[clamp(0.5rem,calc(50vw-33rem),4rem)] side:max-h-screen side:w-50 side:overflow-y-auto side:pt-20 side:pr-2 side:pl-4 side:[scrollbar-width:none]">
    <HubLogo className="size-12" />
    <div className="pt-7">
      <Search
        machines={nav.machines}
        now={now}
        onJump={onJump}
        shortcut={shortcut}
      />
    </div>
    <nav aria-label="Machines" className="text-nav flex flex-col gap-7 pt-7">
      <Nav {...nav} />
    </nav>
    <div className="bg-paper before:to-paper sticky bottom-0 mt-6 flex flex-col items-start gap-2 pt-2 pb-8 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-linear-to-b before:from-transparent">
      <button
        className="text-nav text-soft hover:text-ink cursor-pointer text-left tabular-nums transition-colors duration-100"
        onClick={onRefresh}
        type="button"
      >
        {status}
      </button>
      <button
        className="text-nav text-muted hover:text-ink cursor-pointer text-left transition-colors duration-100"
        onClick={onSignOut}
        type="button"
      >
        Sign out
      </button>
    </div>
  </aside>
);
