import { describe, expect, test } from "bun:test";

import {
  canPair,
  canPublish,
  canUnpublish,
  describeActionReply,
  eligibleActions,
  MACHINE_ACTIONS,
  needsUpdate,
  PAIR_TTL_MS,
  requestAction,
  trustCommand,
  tunnelHostname,
} from "@/lib/actions";
import type { FetchLike } from "@/lib/auth";
import type { Cloudflare, Machine } from "@/lib/machines";

const CLOUDFLARE: Cloudflare = { zone: "example.com" };

const base: Machine = {
  here: false,
  kind: "computer",
  name: "edge-7",
  spoke: "trusted",
  state: "t3",
  t3: {
    environmentId: "id",
    label: "edge-7",
    latencyMs: 18,
    link: null,
    url: "https://edge-7.example.com",
    version: "0.1.13",
  },
  tailscale: null,
  tunnel: null,
  vitals: null,
};

const machineWith = (over: Partial<Machine>) => ({ ...base, ...over });

const SAMPLE_LINK = "https://edge-7.example.com/pair?token=sample-pair-secret";
const PUBLIC_URL = "https://t3-edge-7.example.com";

describe("needsUpdate", () => {
  test("is true only when both versions are known and differ", () => {
    expect(needsUpdate(base, "0.1.14")).toBe(true);
    expect(needsUpdate(base, "0.1.13")).toBe(false);
    expect(needsUpdate(base, null)).toBe(false);
    expect(
      needsUpdate(
        machineWith({
          t3: {
            environmentId: "id",
            label: "edge-7",
            latencyMs: null,
            link: null,
            url: null,
            version: null,
          },
        }),
        "0.1.14"
      )
    ).toBe(false);
    expect(
      needsUpdate(machineWith({ state: "online", t3: null }), "0.1.14")
    ).toBe(false);
  });
});

describe("trustCommand", () => {
  test("puts the hub key into the spoke trust command", () => {
    expect(trustCommand("pub-key-123")).toBe(
      "devbox up --spoke --trust pub-key-123"
    );
  });
});

describe("tunnelHostname", () => {
  test("lowercases the machine name and replaces characters outside a-z0-9 with hyphens", () => {
    expect(tunnelHostname("edge-7", "example.com")).toBe(
      "t3-edge-7.example.com"
    );
    expect(tunnelHostname("My_Box 01", "example.com")).toBe(
      "t3-my-box-01.example.com"
    );
  });
});

describe("action eligibility", () => {
  test("canPair is true only when spoke is trusted and state is t3", () => {
    expect(canPair(base)).toBe(true);
    expect(canPair(machineWith({ spoke: "untrusted" }))).toBe(false);
    expect(canPair(machineWith({ spoke: null }))).toBe(false);
    expect(canPair(machineWith({ state: "online" }))).toBe(false);
    expect(canPair(machineWith({ state: "offline" }))).toBe(false);
  });

  test("publish and unpublish require cloudflare and a trusted spoke", () => {
    expect(canPublish(base, CLOUDFLARE)).toBe(true);
    expect(canUnpublish(base, CLOUDFLARE)).toBe(false);

    expect(canPublish(base, null)).toBe(false);
    expect(canUnpublish(base, null)).toBe(false);

    const published = machineWith({ tunnel: { url: PUBLIC_URL } });
    expect(canPublish(published, CLOUDFLARE)).toBe(false);
    expect(canUnpublish(published, CLOUDFLARE)).toBe(true);
    expect(canUnpublish(published, null)).toBe(false);

    expect(canPublish(machineWith({ spoke: "untrusted" }), CLOUDFLARE)).toBe(
      false
    );
    expect(canPublish(machineWith({ spoke: null }), CLOUDFLARE)).toBe(false);
    expect(
      canUnpublish(
        machineWith({ spoke: "untrusted", tunnel: { url: PUBLIC_URL } }),
        CLOUDFLARE
      )
    ).toBe(false);
  });

  test("eligibleActions lists quiet actions in display order", () => {
    expect(eligibleActions(base, "0.1.14", CLOUDFLARE)).toEqual([
      "update",
      "pair",
      "publish",
    ]);
    expect(
      eligibleActions(
        machineWith({ tunnel: { url: PUBLIC_URL } }),
        "0.1.14",
        CLOUDFLARE
      )
    ).toEqual(["update", "pair", "unpublish"]);
    expect(eligibleActions(base, "0.1.14", null)).toEqual(["update", "pair"]);
  });
});

describe("confirmation sentences", () => {
  test("match the contract word for word", () => {
    expect(MACHINE_ACTIONS.update.confirm("edge-7")).toBe(
      "This restarts T3 Code on edge-7 and stops the agents running there."
    );
    expect(MACHINE_ACTIONS.pair.confirm).toBeNull();
    expect(MACHINE_ACTIONS.publish.confirm("edge-7", "example.com")).toBe(
      "This puts T3 Code on edge-7 on the internet at t3-edge-7.example.com. Its sign-in page becomes public."
    );
    expect(MACHINE_ACTIONS.unpublish.confirm("edge-7")).toBe(
      "This takes edge-7 off the internet. Devices paired through that address stop working."
    );
  });
});

test("pairing links expire after 15 minutes", () => {
  expect(PAIR_TTL_MS).toBe(15 * 60 * 1000);
});

describe("describeActionReply for update", () => {
  test("200 and 202 tell the user the machine was asked to update", () => {
    const expected = {
      message:
        "Asked edge-7 to update. Its version changes here within a few minutes.",
      ok: true,
      signedOut: false,
      url: null,
    };

    expect(describeActionReply("update", "edge-7", 200)).toEqual(expected);
    expect(describeActionReply("update", "edge-7", 202)).toEqual(expected);
  });

  test("401, 403, 404, 409, 502, null and 500 read as sentences", () => {
    expect(describeActionReply("update", "edge-7", 401)).toEqual({
      message: "Your session ended. Sign in again.",
      ok: false,
      signedOut: true,
      url: null,
    });
    expect(describeActionReply("update", "edge-7", 403)).toEqual({
      message: "The hub refused the update request.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("update", "edge-7", 404)).toEqual({
      message: "The hub no longer lists edge-7.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("update", "edge-7", 409)).toEqual({
      message: "edge-7 is not ready to take an update from this hub.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("update", "edge-7", 502)).toEqual({
      message: "edge-7 refused the update or did not answer.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("update", "edge-7", null)).toEqual({
      message: "The hub is not answering.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("update", "edge-7", 500)).toEqual({
      message: "The hub answered with status 500.",
      ok: false,
      signedOut: false,
      url: null,
    });
  });
});

describe("describeActionReply for pair", () => {
  test("200 with a valid link returns the link without printing it in the message", () => {
    const outcome = describeActionReply("pair", "edge-7", 200, {
      url: SAMPLE_LINK,
    });

    expect(outcome).toEqual({
      message: "Pairing link, good for 15 minutes.",
      ok: true,
      signedOut: false,
      url: SAMPLE_LINK,
    });
    expect(outcome.message.includes(SAMPLE_LINK)).toBe(false);
  });

  test("200 without a usable http or https link fails cleanly", () => {
    expect(describeActionReply("pair", "edge-7", 200, { url: null })).toEqual({
      message: "The hub answered without a pairing link.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(
      describeActionReply("pair", "edge-7", 200, {
        url: "ftp://edge-7.example.com",
      })
    ).toEqual({
      message: "The hub answered without a pairing link.",
      ok: false,
      signedOut: false,
      url: null,
    });
  });

  test("401, 403, 404, 409, 502, null and 500 read as sentences", () => {
    expect(describeActionReply("pair", "edge-7", 401)).toEqual({
      message: "Your session ended. Sign in again.",
      ok: false,
      signedOut: true,
      url: null,
    });
    expect(describeActionReply("pair", "edge-7", 403)).toEqual({
      message: "The hub refused the pairing request.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("pair", "edge-7", 404)).toEqual({
      message: "The hub no longer lists edge-7.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("pair", "edge-7", 409)).toEqual({
      message: "edge-7 does not trust this hub for pairing.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("pair", "edge-7", 502)).toEqual({
      message: "edge-7 refused the pairing request or did not answer.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("pair", "edge-7", null)).toEqual({
      message: "The hub is not answering.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("pair", "edge-7", 500)).toEqual({
      message: "The hub answered with status 500.",
      ok: false,
      signedOut: false,
      url: null,
    });
  });
});

describe("describeActionReply for publish", () => {
  test("202 tells the user the public address and that it can take a minute", () => {
    expect(
      describeActionReply("publish", "edge-7", 202, { url: PUBLIC_URL })
    ).toEqual({
      message:
        "Asked edge-7 to go public at https://t3-edge-7.example.com. It can take a minute.",
      ok: true,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("publish", "edge-7", 202)).toEqual({
      message: "Asked edge-7 to go public. It can take a minute.",
      ok: true,
      signedOut: false,
      url: null,
    });
  });

  test("401, 403, 404, 409, null and 500 read as sentences", () => {
    expect(describeActionReply("publish", "edge-7", 401)).toEqual({
      message: "Your session ended. Sign in again.",
      ok: false,
      signedOut: true,
      url: null,
    });
    expect(describeActionReply("publish", "edge-7", 403)).toEqual({
      message: "The hub refused the publish request.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("publish", "edge-7", 404)).toEqual({
      message: "The hub no longer lists edge-7.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("publish", "edge-7", 409)).toEqual({
      message: "edge-7 is not ready to be published from this hub.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("publish", "edge-7", null)).toEqual({
      message: "The hub is not answering.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("publish", "edge-7", 500)).toEqual({
      message: "The hub answered with status 500.",
      ok: false,
      signedOut: false,
      url: null,
    });
  });

  test("502 names the step the hub reported, or falls back cleanly", () => {
    expect(
      describeActionReply("publish", "edge-7", 502, { step: "WAF rule" })
    ).toEqual({
      message: "Publishing edge-7 failed at WAF rule.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(
      describeActionReply("publish", "edge-7", 502, {
        error: "Could not create the CNAME record.",
      })
    ).toEqual({
      message: "Could not create the CNAME record.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(
      describeActionReply("publish", "edge-7", 502, { error: "ingress" })
    ).toEqual({
      message: "Publishing edge-7 failed at ingress.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("publish", "edge-7", 502)).toEqual({
      message:
        "Could not publish edge-7. Cloudflare or the machine did not answer.",
      ok: false,
      signedOut: false,
      url: null,
    });
  });
});

describe("describeActionReply for unpublish", () => {
  test("204 tells the user the machine was asked to leave the internet", () => {
    expect(describeActionReply("unpublish", "edge-7", 204)).toEqual({
      message: "Asked edge-7 to leave the internet.",
      ok: true,
      signedOut: false,
      url: null,
    });
  });

  test("401, 403, 404, 409, 502, null and 500 read as sentences", () => {
    expect(describeActionReply("unpublish", "edge-7", 401)).toEqual({
      message: "Your session ended. Sign in again.",
      ok: false,
      signedOut: true,
      url: null,
    });
    expect(describeActionReply("unpublish", "edge-7", 403)).toEqual({
      message: "The hub refused the unpublish request.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("unpublish", "edge-7", 404)).toEqual({
      message: "The hub no longer lists edge-7.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("unpublish", "edge-7", 409)).toEqual({
      message: "edge-7 is not ready to be unpublished from this hub.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(
      describeActionReply("unpublish", "edge-7", 502, { step: "CNAME record" })
    ).toEqual({
      message: "Unpublishing edge-7 failed at CNAME record.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("unpublish", "edge-7", 502)).toEqual({
      message:
        "Could not unpublish edge-7. Cloudflare or the machine did not answer.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("unpublish", "edge-7", null)).toEqual({
      message: "The hub is not answering.",
      ok: false,
      signedOut: false,
      url: null,
    });
    expect(describeActionReply("unpublish", "edge-7", 500)).toEqual({
      message: "The hub answered with status 500.",
      ok: false,
      signedOut: false,
      url: null,
    });
  });
});

const failingRequest: FetchLike = () => {
  throw new Error("offline");
};

const malformedPair: FetchLike = () =>
  new Response("not-json", { status: 200 });

const publishStepFailure: FetchLike = () =>
  Response.json({ step: "creating the tunnel" }, { status: 502 });

describe("requestAction", () => {
  test("posts update to /api/machines/<name>/update using the cookie", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;

    const fakeRequest: FetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;

      return Response.json({ asked: true }, { status: 202 });
    };

    const result = await requestAction("update", "edge-7", fakeRequest);

    expect(seenUrl).toBe("/api/machines/edge-7/update");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.cache).toBe("no-store");
    expect(new Headers(seenInit?.headers).get("authorization")).toBeNull();
    expect(result.ok).toBe(true);
  });

  test("posts pair to /api/machines/<name>/pair and returns the link", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;

    const fakeRequest: FetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;

      return Response.json(
        { url: SAMPLE_LINK },
        { headers: { "cache-control": "no-store" }, status: 200 }
      );
    };

    const result = await requestAction("pair", "edge-7", fakeRequest);

    expect(seenUrl).toBe("/api/machines/edge-7/pair");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.cache).toBe("no-store");
    expect(new Headers(seenInit?.headers).get("authorization")).toBeNull();
    expect(result).toEqual({
      message: "Pairing link, good for 15 minutes.",
      ok: true,
      signedOut: false,
      url: SAMPLE_LINK,
    });
  });

  test("handles a 200 pair reply with malformed JSON", async () => {
    expect(await requestAction("pair", "edge-7", malformedPair)).toEqual(
      describeActionReply("pair", "edge-7", 200)
    );
  });

  test("posts publish to /api/machines/<name>/tunnel and reads the public url", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;

    const fakeRequest: FetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;

      return Response.json({ url: PUBLIC_URL }, { status: 202 });
    };

    const result = await requestAction("publish", "edge-7", fakeRequest);

    expect(seenUrl).toBe("/api/machines/edge-7/tunnel");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.cache).toBe("no-store");
    expect(new Headers(seenInit?.headers).get("authorization")).toBeNull();
    expect(result).toEqual({
      message:
        "Asked edge-7 to go public at https://t3-edge-7.example.com. It can take a minute.",
      ok: true,
      signedOut: false,
      url: null,
    });
  });

  test("reads the failing step from a 502 publish reply", async () => {
    expect(
      await requestAction("publish", "edge-7", publishStepFailure)
    ).toEqual({
      message: "Publishing edge-7 failed at creating the tunnel.",
      ok: false,
      signedOut: false,
      url: null,
    });
  });

  test("sends DELETE to /api/machines/<name>/tunnel on unpublish", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;

    const fakeRequest: FetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;

      return new Response(null, { status: 204 });
    };

    const result = await requestAction("unpublish", "edge-7", fakeRequest);

    expect(seenUrl).toBe("/api/machines/edge-7/tunnel");
    expect(seenInit?.method).toBe("DELETE");
    expect(seenInit?.cache).toBe("no-store");
    expect(new Headers(seenInit?.headers).get("authorization")).toBeNull();
    expect(result).toEqual({
      message: "Asked edge-7 to leave the internet.",
      ok: true,
      signedOut: false,
      url: null,
    });
  });

  test("turns a rejected fetch into a network failure outcome", async () => {
    expect(await requestAction("publish", "edge-7", failingRequest)).toEqual(
      describeActionReply("publish", "edge-7", null)
    );
    expect(await requestAction("unpublish", "edge-7", failingRequest)).toEqual(
      describeActionReply("unpublish", "edge-7", null)
    );
  });
});
