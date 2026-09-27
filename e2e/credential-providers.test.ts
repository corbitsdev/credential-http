// Providers registered in a real `@intx/harness` registry and resolved through
// the grant-gated credential capability, against two local servers: the
// credential's origin and a hostile one that must never see the secret.

import { afterAll, expect, test } from "bun:test";
import { toolConsumer, type GrantRule } from "@intx/authz";
import {
  builtinCredentialProviders,
  createCredentialCapability,
  createCredentialProviderRegistry,
  type ResolvedCredentialBinding,
} from "@intx/harness";
import type { CredentialProvider, HttpMediatedCredential } from "@intx/types";

import {
  createHeaderCredentialProvider,
  createMcpStreamableHttpCredentialProvider,
  createOriginPinnedFetch,
  createRawAuthorizationCredentialProvider,
  createXApiKeyCredentialProvider,
  MCP_NO_TOKEN_SENTINEL,
  MCP_STREAMABLE_HTTP_PROVIDER_KEY,
  RAW_AUTHORIZATION_PROVIDER_KEY,
  X_API_KEY_PROVIDER_KEY,
} from "../src/index.js";

type Seen = { path: string; headers: Headers };

function recordingServer(
  respond: (req: Request) => Response = () => new Response("ok"),
) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, headers: req.headers });
      return respond(req);
    },
  });
  return { server, seen, origin: server.url.origin };
}

const hostile = recordingServer();
const upstream = recordingServer((req) =>
  new URL(req.url).pathname === "/redirect"
    ? Response.redirect(`${hostile.origin}/steal`, 302)
    : new Response("ok"),
);

afterAll(() => {
  upstream.server.stop(true);
  hostile.server.stop(true);
});

const CONSUMER = toolConsumer("@corbits/credential-http-e2e");

async function resolveHandle(
  provider: CredentialProvider,
  readSecret: () => string,
): Promise<HttpMediatedCredential> {
  const binding: ResolvedCredentialBinding = {
    credentialId: "cred_e2e",
    providerKey: provider.key,
    origin: `${upstream.origin}/api`,
    readCurrentMaterial: () => ({ secret: readSecret() }),
  };
  const grant: GrantRule = {
    id: "grt_e2e",
    origin: "system",
    resource: "credential:cred_e2e",
    action: "use",
    effect: "allow",
    conditions: { tool: CONSUMER },
    expiresAt: null,
    roleId: null,
    principalId: null,
  };
  const credentials = createCredentialCapability({
    consumer: CONSUMER,
    bindings: new Map([["upstream", binding]]),
    providers: createCredentialProviderRegistry([
      ...builtinCredentialProviders(),
      provider,
    ]),
    grants: [grant],
  });
  return await credentials.resolve("upstream");
}

function lastSeen(): Seen {
  const seen = upstream.seen.at(-1);
  if (seen === undefined) throw new Error("upstream saw no request");
  return seen;
}

test("presets register under their plugin keys and send their header shape", async () => {
  const cases = [
    {
      provider: createXApiKeyCredentialProvider(),
      key: X_API_KEY_PROVIDER_KEY,
      header: "x-api-key",
      value: "sk-1",
    },
    {
      provider: createRawAuthorizationCredentialProvider(),
      key: RAW_AUTHORIZATION_PROVIDER_KEY,
      header: "authorization",
      value: "sk-1",
    },
    {
      provider: createMcpStreamableHttpCredentialProvider(),
      key: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
      header: "authorization",
      value: "Bearer sk-1",
    },
    {
      provider: createHeaderCredentialProvider({
        key: "http-token",
        header: "authorization",
        prefix: "Token",
      }),
      key: "http-token",
      header: "authorization",
      value: "Token sk-1",
    },
  ];
  for (const { provider, key, header, value } of cases) {
    expect(provider.key).toBe(key);
    const handle = await resolveHandle(provider, () => "sk-1");
    const response = await handle.fetch("/search", { method: "POST" });
    expect(response.status).toBe(200);
    expect(lastSeen().path).toBe("/search");
    expect(lastSeen().headers.get(header)).toBe(value);
  }
});

test("a Request input keeps its headers and gains the credential", async () => {
  const handle = await resolveHandle(
    createXApiKeyCredentialProvider(),
    () => "sk-1",
  );
  await handle.fetch(
    new Request(`${upstream.origin}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(lastSeen().headers.get("content-type")).toBe("application/json");
  expect(lastSeen().headers.get("x-api-key")).toBe("sk-1");
});

test("a rotated secret is sent on the next request", async () => {
  let secret = "sk-old";
  const handle = await resolveHandle(
    createXApiKeyCredentialProvider(),
    () => secret,
  );
  await handle.fetch("/a");
  expect(lastSeen().headers.get("x-api-key")).toBe("sk-old");
  secret = "sk-new";
  await handle.fetch("/b");
  expect(lastSeen().headers.get("x-api-key")).toBe("sk-new");
});

test("the keyless sentinel sends no authorization, even one the caller set", async () => {
  const handle = await resolveHandle(
    createMcpStreamableHttpCredentialProvider(),
    () => MCP_NO_TOKEN_SENTINEL,
  );
  await handle.fetch("/mcp", { headers: { authorization: "Bearer forged" } });
  expect(lastSeen().headers.has("authorization")).toBe(false);
});

test("an empty secret sends no credential header", async () => {
  for (const provider of [
    createXApiKeyCredentialProvider(),
    createMcpStreamableHttpCredentialProvider(),
  ]) {
    const handle = await resolveHandle(provider, () => "");
    await handle.fetch("/empty");
    expect(lastSeen().headers.has("x-api-key")).toBe(false);
    expect(lastSeen().headers.has("authorization")).toBe(false);
  }
});

test("the credential overwrites a header the caller set", async () => {
  const handle = await resolveHandle(
    createXApiKeyCredentialProvider(),
    () => "sk-1",
  );
  await handle.fetch("/a", { headers: { "x-api-key": "forged" } });
  expect(lastSeen().headers.get("x-api-key")).toBe("sk-1");
});

test("a cross-origin request is refused and the hostile origin sees nothing", async () => {
  const handle = await resolveHandle(
    createXApiKeyCredentialProvider(),
    () => "sk-1",
  );
  await expect(handle.fetch(`${hostile.origin}/steal`)).rejects.toThrow(
    `refusing cross-origin request to ${hostile.origin}`,
  );
  await expect(
    handle.fetch(new Request(`${hostile.origin}/steal`)),
  ).rejects.toThrow(`refusing cross-origin request to ${hostile.origin}`);
  expect(hostile.seen).toHaveLength(0);
});

test("a redirect to another origin is returned unfollowed", async () => {
  const handle = await resolveHandle(
    createXApiKeyCredentialProvider(),
    () => "sk-1",
  );
  const response = await handle.fetch("/redirect");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${hostile.origin}/steal`);
  expect(hostile.seen).toHaveLength(0);
});

test("extraOrigins allows only the origins listed for the pinned origin", async () => {
  const provider = createMcpStreamableHttpCredentialProvider({
    extraOrigins: { [upstream.origin]: [hostile.origin] },
  });
  const handle = await resolveHandle(provider, () => "sk-1");
  await handle.fetch(`${hostile.origin}/mcp`);
  expect(hostile.seen.at(-1)?.headers.get("authorization")).toBe("Bearer sk-1");

  const unlisted = createMcpStreamableHttpCredentialProvider({
    extraOrigins: { "https://mcp.example.com": [hostile.origin] },
  });
  const pinned = await resolveHandle(unlisted, () => "sk-1");
  await expect(pinned.fetch(`${hostile.origin}/mcp`)).rejects.toThrow(
    "refusing cross-origin request",
  );
});

test("createOriginPinnedFetch pins a bare fetch outside the provider registry", async () => {
  const pinned = createOriginPinnedFetch({
    origin: upstream.origin,
    header: "authorization",
    readValue: () => "Bearer sk-1",
  });
  await pinned("/mcp");
  expect(lastSeen().headers.get("authorization")).toBe("Bearer sk-1");
  await expect(pinned(`${hostile.origin}/mcp`)).rejects.toThrow(
    "refusing cross-origin request",
  );
});

test("a secret with CR/LF is refused without echoing it or reaching the origin", async () => {
  const secret = "sk-1\r\nx-injected: stolen";
  const handle = await resolveHandle(
    createXApiKeyCredentialProvider(),
    () => secret,
  );
  const before = upstream.seen.length;
  const error = await handle.fetch("/crlf").then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "credential value for x-api-key is not a valid header value",
  );
  expect((error as Error).message).not.toContain("sk-1");
  expect(upstream.seen).toHaveLength(before);
});

test("an invalid header name is refused at provider construction", () => {
  expect(() =>
    createHeaderCredentialProvider({ key: "bad", header: "x key\r\n" }),
  ).toThrow("invalid credential header name");
});
