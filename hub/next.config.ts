import type { NextConfig } from "next";

const hubUrl = process.env.DEVBOX_HUB_URL ?? "http://127.0.0.1:3780";

const shared: NextConfig = {
  turbopack: { root: import.meta.dirname },
};

const config: NextConfig =
  process.env.NODE_ENV === "development"
    ? {
        ...shared,
        // oxlint-disable-next-line require-await -- Next takes rewrites only as a promise
        rewrites: async () => [
          {
            destination: `${hubUrl}/api/machines`,
            source: "/api/machines",
          },
        ],
      }
    : { ...shared, output: "export" };

export default config;
