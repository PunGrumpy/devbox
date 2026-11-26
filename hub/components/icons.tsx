import type { SVGProps } from "react";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  viewBox: "0 0 24 24",
} as const;

export const HubGlyph = (props: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden="true" height="20" viewBox="0 0 24 24" width="20" {...props}>
    <rect className="fill-ink" height="24" rx="6" width="24" />
    <path
      className="stroke-paper"
      d="M12 12 6.5 7M12 12l5.5-5M12 12v6.5"
      strokeLinecap="round"
      strokeWidth="1.6"
    />
    <circle className="fill-accent" cx="12" cy="12" r="2.6" />
  </svg>
);

export const RefreshIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    height="15"
    strokeWidth="2"
    width="15"
    {...stroke}
    {...props}
  >
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 4v5h-5" />
  </svg>
);

export const ArrowIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    height="11"
    strokeWidth="2.2"
    width="11"
    {...stroke}
    {...props}
  >
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

export const CopyIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    height="14"
    strokeWidth="2"
    width="14"
    {...stroke}
    {...props}
  >
    <rect height="12" rx="2.5" width="12" x="9" y="9" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);

export const CheckIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    height="14"
    strokeWidth="2.4"
    width="14"
    {...stroke}
    {...props}
  >
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
