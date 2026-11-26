import { HubGlyph, SearchIcon } from "@/components/icons";
import { FILTERS } from "@/lib/machines";
import type { FilterKey, Machine } from "@/lib/machines";

const NAV_LINK =
  "-ml-1.5 block w-[calc(100%+0.375rem)] cursor-pointer rounded-md px-1.5 py-1 text-left transition-colors duration-100 hover:text-ink";

interface FiltersProps {
  filter: FilterKey;
  machines: readonly Machine[];
  onFilter: (filter: FilterKey) => void;
}

export const Filters = ({ filter, machines, onFilter }: FiltersProps) => (
  <ul>
    {FILTERS.map(({ key, label, test }) => (
      <li key={key}>
        <button
          aria-pressed={key === filter}
          className={`${NAV_LINK} text-soft aria-pressed:text-ink`}
          onClick={() => {
            onFilter(key);
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
);

interface SidebarProps extends FiltersProps {
  onQuery: (query: string) => void;
  onRefresh: () => void;
  query: string;
  sections: readonly { key: string; label: string }[];
  status: string;
}

export const Sidebar = ({
  filter,
  machines,
  onFilter,
  onQuery,
  onRefresh,
  query,
  sections,
  status,
}: SidebarProps) => (
  <aside className="max-side:hidden fixed top-0 left-[clamp(0.5rem,calc(50vw-33rem),4rem)] flex h-dvh w-50 flex-col pt-20 pr-2 pb-8 pl-4">
    <HubGlyph className="size-12 shrink-0 rounded-(--radius-icon)" />
    <label className="edge text-nav text-muted focus-within:outline-focus mt-7 -ml-3 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-full px-2.5 py-1.5 [--fill:var(--paper)] focus-within:outline-2 focus-within:outline-offset-2">
      <SearchIcon className="shrink-0" />
      <span className="sr-only">Filter machines by name</span>
      <input
        className="text-ink placeholder:text-muted min-w-0 flex-1 bg-transparent outline-none"
        onChange={(event) => {
          onQuery(event.target.value);
        }}
        placeholder="Filter"
        type="search"
        value={query}
      />
    </label>
    <nav
      aria-label="Machines"
      className="text-nav mt-7 flex flex-col gap-7 overflow-y-auto"
    >
      <Filters filter={filter} machines={machines} onFilter={onFilter} />
      <div>
        <h2 className="text-muted pb-3">On this page</h2>
        <ul>
          {[...sections, { key: "agents", label: "For agents" }].map(
            ({ key, label }) => (
              <li key={key}>
                <a className={`${NAV_LINK} text-soft`} href={`#${key}`}>
                  {label}
                </a>
              </li>
            )
          )}
        </ul>
      </div>
    </nav>
    <button
      className="text-nav text-soft hover:text-ink mt-auto cursor-pointer self-start pt-6 text-left tabular-nums transition-colors duration-100"
      onClick={onRefresh}
      type="button"
    >
      {status}
    </button>
  </aside>
);
