import Image from "next/image";
import type { SVGProps } from "react";

import type { MachineKind, MachineState } from "@/lib/machines";

type IconProps = SVGProps<SVGSVGElement>;

export const SearchIcon = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" {...props}>
    <circle
      cx="7"
      cy="7"
      fill="none"
      r="4.75"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="m10.5 10.5 3.25 3.25"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
);

export const CloseIcon = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" {...props}>
    <path
      d="m4.5 4.5 7 7m0-7-7 7"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
);

interface CopyIconProps extends IconProps {
  copied: boolean;
}

/** The copy mark of the Rex docs: two sheets, or a tick once the text is on the clipboard. */
export const CopyIcon = ({ copied, ...props }: CopyIconProps) => (
  <svg
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.25"
    viewBox="0 0 16 16"
    {...props}
  >
    {copied ? (
      <path d="M3.5 8.5l3 3 6-7" />
    ) : (
      <g>
        <rect height="8" rx="2" width="8" x="5.5" y="5.5" />
        <path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" />
      </g>
    )}
  </svg>
);

const ComputerIcon = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <path
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      d="M14 21h2m-2 0a1.5 1.5 0 0 1-1.5-1.5V17H12m2 4h-4m0 0H8m2 0a1.5 1.5 0 0 0 1.5-1.5V17h.5m0 0v4m4-18H8c-2.828 0-4.243 0-5.121.879C2 4.757 2 6.172 2 9v2c0 2.828 0 4.243.879 5.121C3.757 17 5.172 17 8 17h8c2.828 0 4.243 0 5.121-.879C22 15.243 22 13.828 22 11V9c0-2.828 0-4.243-.879-5.121C20.243 3 18.828 3 16 3"
    />
  </svg>
);

const FinderIcon = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <g
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.5"
    >
      <path d="M2.5 12c0-4.478 0-6.718 1.391-8.109S7.521 2.5 12 2.5c4.478 0 6.718 0 8.109 1.391S21.5 7.521 21.5 12c0 4.478 0 6.718-1.391 8.109S16.479 21.5 12 21.5c-4.478 0-6.718 0-8.109-1.391S2.5 16.479 2.5 12Z" />
      <path strokeLinecap="round" d="M7 8v2m10-2v2M7 16.5c3.5 2 6.5 2 10 0" />
      <path
        strokeLinecap="round"
        d="M12.99 2.5c-.866 1.285-2.474 5.213-2.916 9.08c-.093.81-.14 1.215.117 1.538c.024.03.056.066.085.094c.295.288.739.288 1.627.288c.486 0 .729 0 .874.131l.042.044c.128.147.12.397.102.896c-.053 1.545.02 4.481 1.079 6.929"
      />
    </g>
  </svg>
);

const WindowsIcon = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <path
      d="M2 2h9.48v9.48H2zm10.52 0H22v9.48h-9.48zM2 12.52h9.48V22H2zm10.52 0H22V22h-9.48z"
      fill="currentColor"
    />
  </svg>
);

const LinuxIcon = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <path
      fill="currentColor"
      d="M19.7 17.6c-.1-.2-.2-.4-.2-.6c0-.4-.2-.7-.5-1c-.1-.1-.3-.2-.4-.2c.6-1.8-.3-3.6-1.3-4.9c-.8-1.2-2-2.1-1.9-3.7c0-1.9.2-5.4-3.3-5.1c-3.6.2-2.6 3.9-2.7 5.2c0 1.1-.5 2.2-1.3 3.1c-.2.2-.4.5-.5.7c-1 1.2-1.5 2.8-1.5 4.3c-.2.2-.4.4-.5.6c-.1.1-.2.2-.2.3c-.1.1-.3.2-.5.3c-.4.1-.7.3-.9.7c-.1.3-.2.7-.1 1.1c.1.2.1.4 0 .7c-.2.4-.2.9 0 1.4c.3.4.8.5 1.5.6c.5 0 1.1.2 1.6.4c.5.3 1.1.5 1.7.5c.3 0 .7-.1 1-.2c.3-.2.5-.4.6-.7c.4 0 1-.2 1.7-.2c.6 0 1.2.2 2 .1c0 .1 0 .2.1.3c.2.5.7.9 1.3 1h.2c.8-.1 1.6-.5 2.1-1.1c.4-.4.9-.7 1.4-.9c.6-.3 1-.5 1.1-1c.1-.7-.1-1.1-.5-1.7M12.8 4.8c.6.1 1.1.6 1 1.2q0 .45-.3.9h-.1c-.2-.1-.3-.1-.4-.2c.1-.1.1-.3.2-.5c0-.4-.2-.7-.4-.7c-.3 0-.5.3-.5.7v.1c-.1-.1-.3-.1-.4-.2V6c-.1-.5.3-1.1.9-1.2m-.3 2c.1.1.3.2.4.2s.3.1.4.2c.2.1.4.2.4.5s-.3.6-.9.8c-.2.1-.3.1-.4.2c-.3.2-.6.3-1 .3c-.3 0-.6-.2-.8-.4c-.1-.1-.2-.2-.4-.3c-.1-.1-.3-.3-.4-.6c0-.1.1-.2.2-.3c.3-.2.4-.3.5-.4l.1-.1c.2-.3.6-.5 1-.5c.3.1.6.2.9.4M10.4 5c.4 0 .7.4.8 1.1v.2c-.1 0-.3.1-.4.2v-.2c0-.3-.2-.6-.4-.5c-.2 0-.3.3-.3.6c0 .2.1.3.2.4c0 0-.1.1-.2.1c-.2-.2-.4-.5-.4-.8c0-.6.3-1.1.7-1.1m-1 16.1c-.7.3-1.6.2-2.2-.2c-.6-.3-1.1-.4-1.8-.4c-.5-.1-1-.1-1.1-.3s-.1-.5.1-1q.15-.45 0-.9c-.1-.3-.1-.5 0-.8s.3-.4.6-.5s.5-.2.7-.4c.1-.1.2-.2.3-.4c.3-.4.5-.6.8-.6c.6.1 1.1 1 1.5 1.9c.2.3.4.7.7 1c.4.5.9 1.2.9 1.6c0 .5-.2.8-.5 1m4.9-2.2c0 .1 0 .1-.1.2c-1.2.9-2.8 1-4.1.3l-.6-.9c.9-.1.7-1.3-1.2-2.5c-2-1.3-.6-3.7.1-4.8c.1-.1.1 0-.3.8c-.3.6-.9 2.1-.1 3.2c0-.8.2-1.6.5-2.4c.7-1.3 1.2-2.8 1.5-4.3c.1.1.1.1.2.1c.1.1.2.2.3.2c.2.3.6.4.9.4h.1c.4 0 .8-.1 1.1-.4c.1-.1.2-.2.4-.2q.45-.15.9-.6c.4 1.3.8 2.5 1.4 3.6c.4.8.7 1.6.9 2.5c.3 0 .7.1 1 .3c.8.4 1.1.7 1 1.2H18c0-.3-.2-.6-.9-.9s-1.3-.3-1.5.4c-.1 0-.2.1-.3.1c-.8.4-.8 1.5-.9 2.6c.1.4 0 .7-.1 1.1m4.6.6c-.6.2-1.1.6-1.5 1.1c-.4.6-1.1 1-1.9.9c-.4 0-.8-.3-.9-.7c-.1-.6-.1-1.2.2-1.8c.1-.4.2-.7.3-1.1c.1-1.2.1-1.9.6-2.2c0 .5.3.8.7 1c.5 0 1-.1 1.4-.5h.2c.3 0 .5 0 .7.2s.3.5.3.7c0 .3.2.6.3.9c.5.5.5.8.5.9c-.1.2-.5.4-.9.6m-9-12c-.1 0-.1 0-.1.1c0 0 0 .1.1.1s.1.1.1.1c.3.4.8.6 1.4.7c.5-.1 1-.2 1.5-.6l.6-.3c.1 0 .1-.1.1-.1c0-.1 0-.1-.1-.1c-.2.1-.5.2-.7.3c-.4.3-.9.5-1.4.5s-.9-.3-1.2-.6c-.1 0-.2-.1-.3-.1"
    />
  </svg>
);

/**
 * The mark of a system, from the icon sets the Rex docs use: Finder and the plain computer from
 * Hugeicons (MIT), and Tux from Unicons (Apache 2.0).
 */
export const OsIcon = ({ os, ...props }: IconProps & { os: string }) => {
  if (os === "macos") {
    return <FinderIcon {...props} />;
  }

  if (os === "windows") {
    return <WindowsIcon {...props} />;
  }

  if (os === "linux") {
    return <LinuxIcon {...props} />;
  }

  return <ComputerIcon {...props} />;
};

const ComputerGlyph = () => (
  <g fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 4H5c-.932 0-1.398 0-1.765.152a2 2 0 0 0-1.083 1.083C2 5.602 2 6.068 2 7s0 1.398.152 1.765a2 2 0 0 0 1.083 1.083C3.602 10 4.068 10 5 10h14c.932 0 1.398 0 1.765-.152a2 2 0 0 0 1.083-1.083C22 8.398 22 7.932 22 7s0-1.398-.152-1.765a2 2 0 0 0-1.083-1.083C20.398 4 19.932 4 19 4m0 10H5c-.932 0-1.398 0-1.765.152a2 2 0 0 0-1.083 1.083C2 15.602 2 16.068 2 17s0 1.398.152 1.765a2 2 0 0 0 1.083 1.083C3.602 20 4.068 20 5 20h14c.932 0 1.398 0 1.765-.152a2 2 0 0 0 1.083-1.083C22 18.398 22 17.932 22 17s0-1.398-.152-1.765a2 2 0 0 0-1.083-1.083C20.398 14 19.932 14 19 14" />
    <path d="M6.125 7H6m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0m3.875 0H10m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0M6.125 17H6m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0m3.875 0H10m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0" />
  </g>
);

const MacGlyph = () => (
  <path
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    d="M20.5 16.5v-8c0-2.357 0-3.536-.732-4.268C19.035 3.5 17.857 3.5 15.5 3.5h-7c-2.357 0-3.536 0-4.268.732S3.5 6.143 3.5 8.5v8m18.484 4H2.016c-.383 0-.632-.391-.461-.724L3.5 16.5h17l1.945 3.276a.5.5 0 0 1-.46.724"
  />
);

const RemoteGlyph = () => (
  <path
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    d="M17.478 10h.022a4.5 4.5 0 1 1 0 9H7a5 5 0 0 1-.48-9.977M17.478 10q.021-.247.022-.5a5.5 5.5 0 0 0-10.98-.477M17.478 10a5.5 5.5 0 0 1-1.235 3M6.52 9.023Q6.757 9 7 9c1.126 0 2.165.372 3 1"
  />
);

const VmGlyph = () => (
  <path
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    d="M12 2.5a6 6 0 0 1 6 6c0 .552.455.987.99 1.123A4.002 4.002 0 0 1 18 17.5H7a5 5 0 0 1-1.616-9.733a1.3 1.3 0 0 0 .833-.873A6 6 0 0 1 12 2.5m0 15v4m0 0H6m6 0h6"
  />
);

const WindowsGlyph = () => (
  <path
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    d="M14 21h2m-2 0a1.5 1.5 0 0 1-1.5-1.5V17H12m2 4h-4m0 0H8m2 0a1.5 1.5 0 0 0 1.5-1.5V17h.5m0 0v4m4-18H8c-2.828 0-4.243 0-5.121.879C2 4.757 2 6.172 2 9v2c0 2.828 0 4.243.879 5.121C3.757 17 5.172 17 8 17h8c2.828 0 4.243 0 5.121-.879C22 15.243 22 13.828 22 11V9c0-2.828 0-4.243-.879-5.121C20.243 3 18.828 3 16 3"
  />
);

const WslGlyph = () => (
  <g fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path d="m7.5 7.5l1.227 1.057c.515.445.773.667.773.943s-.258.498-.773.943L7.5 11.5m4 1h4" />
    <path d="M12 21c3.75 0 5.625 0 6.939-.955a5 5 0 0 0 1.106-1.106C21 17.625 21 15.749 21 12s0-5.625-.955-6.939a5 5 0 0 0-1.106-1.106C17.625 3 15.749 3 12 3s-5.625 0-6.939.955A5 5 0 0 0 3.955 5.06C3 6.375 3 8.251 3 12s0 5.625.955 6.939a5 5 0 0 0 1.106 1.106C6.375 21 8.251 21 12 21" />
  </g>
);

const KindGlyph = ({ kind }: { kind: MachineKind }) => {
  if (kind === "mac") {
    return <MacGlyph />;
  }

  if (kind === "windows") {
    return <WindowsGlyph />;
  }

  if (kind === "wsl") {
    return <WslGlyph />;
  }

  if (kind === "vm") {
    return <VmGlyph />;
  }

  return kind === "remote" ? <RemoteGlyph /> : <ComputerGlyph />;
};

const TILE_CLASS = {
  offline: "border-rule text-muted border",
  online: "bg-wash text-soft",
  t3: "bg-wash text-ink",
} satisfies Record<MachineState, string>;

interface KindIconProps {
  kind: MachineKind;
  state: MachineState;
}

/**
 * The kind of a machine as a plain glyph on a quiet tile, the way Rex draws every icon that is
 * not an app. Hugeicons, at the 1.5 stroke the docs use.
 */
export const KindIcon = ({ kind, state }: KindIconProps) => (
  <span
    className={`squircle grid size-14 shrink-0 place-items-center rounded-(--radius-icon) ${TILE_CLASS[state]}`}
  >
    <svg
      aria-hidden="true"
      className="size-7"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <KindGlyph kind={kind} />
    </svg>
  </span>
);

/**
 * The hub's app icon, drawn like the Rex one: a glass plate, a figure that runs from yellow through
 * orange and pink to blue, and a name on a pill. Where Rex has a dinosaur, the hub has a mouse of
 * its own. The file follows the reader's color scheme by itself.
 */
export const HubLogo = ({ className = "" }: { className?: string }) => (
  <Image
    alt=""
    className={`block shrink-0 rounded-(--radius-icon) shadow-(--shadow-icon) ${className}`}
    height={48}
    priority
    src="/logo.svg"
    unoptimized
    width={48}
  />
);
