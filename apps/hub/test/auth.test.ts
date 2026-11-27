import { describe, expect, test } from "bun:test";

import { describeLoginReply, requestLogin, requestLogout } from "@/lib/auth";
import type { FetchLike } from "@/lib/auth";
import { createHubStore } from "@/lib/store";

const sampleSnapshot = {
  generatedAt: "2026-11-27T02:49:48Z",
  history: {
    latency: { "edge-7": [18] },
    sampleSeconds: 60,
    startedAt: "2026-11-26T02:50:00Z",
    states: { "edge-7": "2" },
  },
  key: "hub-public-key-sample",
  latest: { t3: "0.1.14" },
  machines: [
    {
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
        version: "0.1.14",
      },
      tailscale: null,
      vitals: null,
    },
  ],
  tailscale: true,
};

const failingFetch: FetchLike = () => {
  throw new Error("offline");
};

describe("describeLoginReply", () => {
  test("200 succeeds", () => {
    expect(describeLoginReply(200)).toEqual({
      message: "Signed in.",
      ok: true,
    });
  });

  test("204 succeeds", () => {
    expect(describeLoginReply(204)).toEqual({
      message: "Signed in.",
      ok: true,
    });
  });

  test("400 asks for the token", () => {
    expect(describeLoginReply(400)).toEqual({
      message: "Enter the hub token.",
      ok: false,
    });
  });

  test("401 says the token was not accepted", () => {
    expect(describeLoginReply(401)).toEqual({
      message: "The hub did not accept that token.",
      ok: false,
    });
  });

  test("403 says the token was not accepted", () => {
    expect(describeLoginReply(403)).toEqual({
      message: "The hub did not accept that token.",
      ok: false,
    });
  });

  test("404 says the hub does not support signing in", () => {
    expect(describeLoginReply(404)).toEqual({
      message: "This hub does not support signing in.",
      ok: false,
    });
  });

  test("409 says the hub cannot sign in right now", () => {
    expect(describeLoginReply(409)).toEqual({
      message: "The hub cannot sign you in right now.",
      ok: false,
    });
  });

  test("502 says the hub could not complete sign-in", () => {
    expect(describeLoginReply(502)).toEqual({
      message: "The hub could not complete sign-in.",
      ok: false,
    });
  });

  test("a network failure says the hub is not answering", () => {
    expect(describeLoginReply(null)).toEqual({
      message: "The hub is not answering.",
      ok: false,
    });
  });

  test("an unexpected status names the status code", () => {
    expect(describeLoginReply(500)).toEqual({
      message: "The hub answered with status 500.",
      ok: false,
    });
  });
});

const createRecorder = (status: number) => {
  const seen: { init: RequestInit | undefined; url: string }[] = [];

  const post: FetchLike = (url, init) => {
    seen.push({ init, url });

    return new Response(null, { status });
  };

  return { post, seen };
};

describe("requestLogin", () => {
  test("posts the token in a JSON body to /api/login", async () => {
    const recorder = createRecorder(204);
    const result = await requestLogin("fake-hub-token", recorder.post);
    const [call] = recorder.seen;

    expect(call?.url).toBe("/api/login");
    expect(call?.url.includes("fake-hub-token")).toBe(false);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.cache).toBe("no-store");
    expect(call?.init?.body).toBe(JSON.stringify({ token: "fake-hub-token" }));
    expect(new Headers(call?.init?.headers).get("content-type")).toBe(
      "application/json"
    );
    expect(new Headers(call?.init?.headers).get("authorization")).toBeNull();
    expect(result.ok).toBe(true);
  });

  test("turns a rejected fetch into a network failure outcome", async () => {
    expect(await requestLogin("fake-hub-token", failingFetch)).toEqual(
      describeLoginReply(null)
    );
  });
});

describe("requestLogout", () => {
  test("posts to /api/logout", async () => {
    const recorder = createRecorder(204);

    await requestLogout(recorder.post);
    const [call] = recorder.seen;

    expect(call?.url).toBe("/api/logout");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.cache).toBe("no-store");
  });
});

describe("createHubStore", () => {
  test("tracks loading, signed-out, signed-in and not-answering states beside the snapshot", async () => {
    const replies: (() => Response)[] = [
      () => Response.json({ error: "sign in" }, { status: 401 }),
      () => Response.json(sampleSnapshot, { status: 200 }),
      () => new Response(null, { status: 502 }),
      () => Response.json({ error: "expired" }, { status: 401 }),
    ];

    const store = createHubStore(() => {
      const reply = replies.shift();

      if (reply === undefined) {
        throw new Error("unexpected request");
      }

      return reply();
    });

    expect(store.getHubState()).toEqual({ snapshot: null, status: "loading" });

    await store.refresh();
    expect(store.getHubState()).toEqual({
      snapshot: null,
      status: "signed-out",
    });

    await store.refresh();
    expect(store.getHubState().status).toBe("signed-in");
    expect(store.getHubState().snapshot?.machines[0]?.name).toBe("edge-7");

    await store.refresh();
    expect(store.getHubState().status).toBe("not-answering");
    expect(store.getHubState().snapshot?.machines[0]?.name).toBe("edge-7");

    await store.refresh();
    expect(store.getHubState()).toEqual({
      snapshot: null,
      status: "signed-out",
    });
  });

  test("signOut posts to /api/logout and drops the snapshot", async () => {
    const seen: string[] = [];

    const store = createHubStore((url) => {
      seen.push(url);

      if (url === "/api/machines") {
        return Response.json(sampleSnapshot, { status: 200 });
      }

      return new Response(null, { status: 204 });
    });

    await store.refresh();
    expect(store.getHubState().status).toBe("signed-in");

    await store.signOut();
    expect(seen).toEqual(["/api/machines", "/api/logout"]);
    expect(store.getHubState()).toEqual({
      snapshot: null,
      status: "signed-out",
    });
  });

  test("markSignedOut drops the snapshot and ignores an older in-flight poll", async () => {
    const deferred = Promise.withResolvers<Response>();
    const store = createHubStore(async () => await deferred.promise);

    const pending = store.refresh();
    store.markSignedOut();

    expect(store.getHubState()).toEqual({
      snapshot: null,
      status: "signed-out",
    });

    deferred.resolve(Response.json(sampleSnapshot, { status: 200 }));
    await pending;

    expect(store.getHubState()).toEqual({
      snapshot: null,
      status: "signed-out",
    });
  });
});
