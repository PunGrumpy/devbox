import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const line = {
  "aria-hidden": true,
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  viewBox: "0 0 24 24",
} as const;

export const HubGlyph = (props: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <rect className="fill-ink" height="24" width="24" />
    <path
      className="stroke-paper"
      d="M12 12 6.5 7M12 12l5.5-5M12 12v6.5"
      strokeLinecap="round"
      strokeWidth="1.6"
    />
    <circle className="fill-paper" cx="12" cy="12" r="2.6" />
  </svg>
);

export const SearchIcon = (props: IconProps) => (
  <svg height="14" strokeWidth="2" width="14" {...line} {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
);

export const CopyIcon = (props: IconProps) => (
  <svg height="16" strokeWidth="1.8" width="16" {...line} {...props}>
    <rect height="12" rx="2.5" width="12" x="9" y="9" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);

export const CheckIcon = (props: IconProps) => (
  <svg height="16" strokeWidth="2.2" width="16" {...line} {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const MachineIcon = (props: IconProps) => (
  <svg strokeWidth="1.5" {...line} {...props}>
    <rect height="11" rx="2" width="17" x="3.5" y="4.5" />
    <path d="M9 19.5h6M12 15.5v4" />
  </svg>
);

const MacIcon = (props: IconProps) => (
  <svg strokeWidth="1.5" {...line} {...props}>
    <rect height="16" rx="4" width="16" x="4" y="4" />
    <path d="M9.5 9v1.5M14.5 9v1.5M12.5 8.5c0 3-.6 4.2-1.5 5h1.6M9 15.5c1.8 1.2 4.2 1.2 6 0" />
  </svg>
);

const WindowsIcon = (props: IconProps) => (
  <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" {...props}>
    <path d="M4 4h7.4v7.4H4zM12.6 4H20v7.4h-7.4zM4 12.6h7.4V20H4zM12.6 12.6H20V20h-7.4z" />
  </svg>
);

const LinuxIcon = (props: IconProps) => (
  <svg strokeWidth="1.5" {...line} {...props}>
    <rect height="15" rx="3" width="17" x="3.5" y="4.5" />
    <path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4" />
  </svg>
);

export const OsIcon = ({ os, ...props }: IconProps & { os: string }) => {
  if (os === "macos") {
    return <MacIcon {...props} />;
  }

  if (os === "windows") {
    return <WindowsIcon {...props} />;
  }

  if (os === "linux") {
    return <LinuxIcon {...props} />;
  }

  return <MachineIcon {...props} />;
};
