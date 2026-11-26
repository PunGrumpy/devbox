import type { SVGProps } from "react";

export const HubGlyph = (props: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <rect className="fill-ink" height="24" rx="6" width="24" />
    <path
      className="stroke-paper"
      d="M12 12 6.5 7M12 12l5.5-5M12 12v6.5"
      strokeLinecap="round"
      strokeWidth="1.6"
    />
    <circle className="fill-paper" cx="12" cy="12" r="2.6" />
  </svg>
);

export const ArrowIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="none"
    height="0.6em"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="0.6em"
    {...props}
  >
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);
