import { useId } from "react";
import type { SVGProps } from "react";

import type { MachineState } from "@/lib/machines";

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

export const CopyIcon = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <g
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    >
      <path d="M7.5 14.5c0-3.3 0-4.95 1.025-5.975S11.2 7.5 14.5 7.5s4.95 0 5.975 1.025S21.5 11.2 21.5 14.5s0 4.95-1.025 5.975S17.8 21.5 14.5 21.5s-4.95 0-5.975-1.025S7.5 17.8 7.5 14.5" />
      <path d="M7.5 16.5c-1.396 0-2.095 0-2.656-.196a3.5 3.5 0 0 1-2.148-2.148C2.5 13.595 2.5 12.896 2.5 11.5v-2c0-3.3 0-4.95 1.025-5.975S6.2 2.5 9.5 2.5h2c1.396 0 2.095 0 2.656.196a3.5 3.5 0 0 1 2.148 2.148c.196.561.196 1.26.196 2.656" />
    </g>
  </svg>
);

export const CheckIcon = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <path
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      d="m5 14l3.5 3.5L19 6.5"
    />
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

const STATE_CLASS = {
  offline: "opacity-40 grayscale",
  online: "opacity-75 grayscale",
  t3: "shadow-(--shadow-icon)",
} satisfies Record<MachineState, string>;

interface AppIconProps {
  className?: string;
  state?: MachineState;
}

/**
 * The hub drawn as an app icon: a soft plate, a figure in a warm gradient and a layered shadow.
 * A machine's card shows it in full color when T3 Code answers, and in gray otherwise.
 */
export const AppIcon = ({ className = "", state = "t3" }: AppIconProps) => {
  const id = useId();
  const plate = `${id}-plate`;
  const figure = `${id}-figure`;

  return (
    <span
      className={`squircle block shrink-0 overflow-hidden rounded-(--radius-icon) ${STATE_CLASS[state]} ${className}`}
    >
      <svg aria-hidden="true" className="block size-full" viewBox="0 0 56 56">
        <defs>
          <linearGradient id={plate} x1="0" x2="1" y1="0" y2="1">
            <stop className="[stop-color:var(--plate-from)]" offset="0" />
            <stop className="[stop-color:var(--plate-to)]" offset="1" />
          </linearGradient>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id={figure}
            x1="45"
            x2="11"
            y1="9"
            y2="49"
          >
            <stop offset="0" stopColor="#ffb648" />
            <stop offset="0.5" stopColor="#ff5c8d" />
            <stop offset="1" stopColor="#8a5cff" />
          </linearGradient>
        </defs>
        <rect fill={`url(#${plate})`} height="56" width="56" />
        <path
          d="M28 30 16.5 18M28 30l11.5-12M28 30v14"
          fill="none"
          stroke={`url(#${figure})`}
          strokeLinecap="round"
          strokeWidth="5.5"
        />
        <g fill={`url(#${figure})`}>
          <circle cx="28" cy="30" r="7.5" />
          <circle cx="16.5" cy="18" r="5" />
          <circle cx="39.5" cy="18" r="5" />
          <circle cx="28" cy="44" r="5" />
        </g>
      </svg>
    </span>
  );
};
