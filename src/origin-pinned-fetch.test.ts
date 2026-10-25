import { expect, test } from "bun:test";
import type { FetchLike } from "@intx/harness";

import { createXApiKeyCredentialProvider } from "./credential-providers.js";
import { createOriginPinnedFetch } from "./origin-pinned-fetch.js";

const SECRET = "super-secret";

function pinned(opts?: {
  readonly origin?: string;
  readonly extraOrigins?: readonly string[];
  readonly fetch?: FetchLike;
  readonly readValue?: () => string | undefined;
}) {
  return createOriginPinnedFetch({
    origin: opts?.origin ?? "https://api.example.com",
    header: "x-api-key",
    readValue: opts?.readValue ?? (() => SECRET),
    ...(opts?.extraOrigins !== undefined
      ? { extraOrigins: opts.extraOrigins }
      : {}),
    ...(opts?.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
}

test("RequestInit overrides a Request and still forces the credential and manual redirect", async () => {
  let seen: Request | undefined;
  const fetchImpl: FetchLike = async (input) => {
    if (!(input instanceof Request)) throw new Error("expected Request");
    seen = input;
    return new Response("ok");
  };
  const req = new Request("https://api.example.com/v1", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "forged" },
    body: '{"a":1}',
    redirect: "follow",
  });
  const response = await pinned({ fetch: fetchImpl })(req, {
    method: "PUT",
    headers: { "x-trace": "1" },
    body: "replaced",
    redirect: "follow",
  });
  expect(response.status).toBe(200);
  if (seen === undefined) throw new Error("delegate was not called");
  expect(seen.method).toBe("PUT");
  expect(await seen.text()).toBe("replaced");
  expect(seen.redirect).toBe("manual");
  expect(seen.headers.get("x-trace")).toBe("1");
  expect(seen.headers.get("content-type")).toBeNull();
  expect(seen.headers.get("x-api-key")).toBe(SECRET);
  expect(seen.url).toBe("https://api.example.com/v1");
});

test("a Request without init keeps its method, body, and headers", async () => {
  let seen: Request | undefined;
  const fetchImpl: FetchLike = async (input) => {
    if (!(input instanceof Request)) throw new Error("expected Request");
    seen = input;
    return new Response("ok");
  };
  await pinned({ fetch: fetchImpl })(
    new Request("https://api.example.com/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  if (seen === undefined) throw new Error("delegate was not called");
  expect(seen.method).toBe("POST");
  expect(await seen.text()).toBe("{}");
  expect(seen.headers.get("content-type")).toBe("application/json");
  expect(seen.headers.get("x-api-key")).toBe(SECRET);
  expect(seen.redirect).toBe("manual");
});

test("a URL input keeps RequestInit, including the header and manual redirect", async () => {
  let seen: { input: unknown; init: RequestInit | undefined } | undefined;
  const fetchImpl: FetchLike = async (input, init) => {
    seen = { input, init };
    return new Response("ok");
  };
  await pinned({ fetch: fetchImpl })(new URL("https://api.example.com/v1"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    redirect: "follow",
  });
  if (seen === undefined) throw new Error("delegate was not called");
  expect(seen.input).toBeInstanceOf(URL);
  expect(seen.init?.method).toBe("POST");
  expect(seen.init?.redirect).toBe("manual");
  expect(seen.init?.body).toBe("{}");
  const headers = new Headers(seen.init?.headers);
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("x-api-key")).toBe(SECRET);
});

test("an abort signal on a URL input rejects the fetch", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });
  try {
    const controller = new AbortController();
    const pending = pinned({ origin: server.url.origin })("/slow", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  } finally {
    server.stop(true);
  }
});

test("an abort signal on a Request rejects the fetch", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });
  try {
    const controller = new AbortController();
    const pending = pinned({ origin: server.url.origin })(
      new Request(`${server.url.origin}/slow`, { signal: controller.signal }),
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  } finally {
    server.stop(true);
  }
});

test("RequestInit signal overrides the Request signal", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });
  try {
    const requestController = new AbortController();
    const initController = new AbortController();
    const pending = pinned({ origin: server.url.origin })(
      new Request(`${server.url.origin}/slow`, {
        signal: requestController.signal,
      }),
      { signal: initController.signal },
    );
    requestController.abort();
    const stillPending = await Promise.race([
      pending.then(
        () => false,
        () => false,
      ),
      Bun.sleep(40).then(() => true),
    ]);
    expect(stillPending).toBe(true);
    initController.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  } finally {
    server.stop(true);
  }
});

test("https and loopback http origins are allowed; other schemes are refused before any fetch", () => {
  const calls: unknown[] = [];
  const fetchImpl: FetchLike = async (...args) => {
    calls.push(args);
    return new Response("ok");
  };
  expect(() =>
    pinned({ origin: "https://api.example.com", fetch: fetchImpl }),
  ).not.toThrow();
  for (const origin of [
    "http://127.0.0.1:9",
    "http://localhost:9",
    "http://[::1]:9",
  ]) {
    expect(() => pinned({ origin, fetch: fetchImpl })).not.toThrow();
  }
  for (const origin of [
    "http://api.example.com",
    "http://127.0.0.2",
    "http://localhost.example.com",
    "http://[::2]",
    "ws://localhost",
    "file:///tmp/secret",
  ]) {
    let error: unknown;
    try {
      pinned({
        origin,
        fetch: fetchImpl,
        readValue: () => SECRET,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("must be https");
    expect((error as Error).message).not.toContain(SECRET);
  }
  expect(calls).toHaveLength(0);
});

test("host extra origins reject non-https and do not leak the secret", async () => {
  const calls: unknown[] = [];
  const fetchImpl: FetchLike = async (...args) => {
    calls.push(args);
    return new Response("ok");
  };
  expect(() =>
    createXApiKeyCredentialProvider({
      fetch: fetchImpl,
      extraOrigins: {
        "https://mcp.example.com": [
          "https://auth.example.com",
          "http://127.0.0.1:9",
        ],
        "http://localhost": ["http://[::1]:9"],
      },
    }),
  ).not.toThrow();

  let error: unknown;
  try {
    createXApiKeyCredentialProvider({
      fetch: fetchImpl,
      extraOrigins: {
        "https://mcp.example.com": ["http://evil.example/steal"],
      },
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(
    "credential transport http://evil.example must be https",
  );
  expect((error as Error).message).not.toContain(SECRET);
  expect(calls).toHaveLength(0);

  let reads = 0;
  const handle = createXApiKeyCredentialProvider({ fetch: fetchImpl }).shape({
    origin: "https://api.example.com/v1",
    readCurrentMaterial: () => {
      reads += 1;
      return { secret: SECRET };
    },
  });
  await expect(handle.fetch("http://evil.example/steal")).rejects.toThrow(
    "refusing cross-origin request to http://evil.example",
  );
  expect(reads).toBe(0);
  expect(calls).toHaveLength(0);
});

test("a redirect is returned unfollowed for Request and URL inputs", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(new URL(req.url).pathname);
      return Response.redirect("http://evil.example/steal", 302);
    },
  });
  try {
    const fetchPinned = pinned({ origin: server.url.origin });
    const fromUrl = await fetchPinned("/redirect", { redirect: "follow" });
    expect(fromUrl.status).toBe(302);
    expect(fromUrl.headers.get("location")).toBe("http://evil.example/steal");
    const fromRequest = await fetchPinned(
      new Request(`${server.url.origin}/from-request`, { redirect: "follow" }),
      { redirect: "follow" },
    );
    expect(fromRequest.status).toBe(302);
    expect(seen).toEqual(["/redirect", "/from-request"]);
  } finally {
    server.stop(true);
  }
});
