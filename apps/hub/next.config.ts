import type { NextConfig } from "next";

const hubUrl = process.env.DEVBOX_HUB_URL ?? "http://127.0.0.1:3780";

const config: NextConfig =
  process.env.NODE_ENV === "development"
    ? {
        // oxlint-disable-next-line require-await -- Next takes rewrites only as a promise
        rewrites: async () => [
          {
            destination: `${hubUrl}/api/:path*`,
            source: "/api/:path*",
          },
        ],
      }
    : { output: "export" };

export default config;
