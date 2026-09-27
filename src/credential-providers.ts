// Credential provider plugins beside `@intx/harness`'s built-in `http`
// (Bearer) provider. A credential row's provider `plugin` column names the
// key of the provider that shapes its handles.

import type { FetchLike } from "@intx/harness";
import type {
  CredentialProvider,
  CredentialShapeContext,
  HttpMediatedCredential,
} from "@intx/types";

import {
  assertHeaderName,
  createOriginPinnedFetch,
} from "./origin-pinned-fetch.js";

/** Plugin key of the `x-api-key` preset. */
export const X_API_KEY_PROVIDER_KEY = "http-x-api-key";

/** Plugin key of the raw `authorization` preset. */
export const RAW_AUTHORIZATION_PROVIDER_KEY = "http-raw-authorization";

/** Plugin key of the MCP streamable HTTP preset. */
export const MCP_STREAMABLE_HTTP_PROVIDER_KEY = "mcp-streamable-http";

/**
 * The secret a keyless MCP server connection stores. Credential storage
 * requires a non-empty secret; the MCP preset reads this value back as "send
 * no `authorization` header".
 */
export const MCP_NO_TOKEN_SENTINEL = "unauthenticated-mcp-server";

/** Options every preset accepts. */
export interface CredentialPresetOptions {
  /**
   * Extra origins a handle may call, keyed by the credential origin it is
   * pinned to. For example `{ "https://mcp.example.com": ["https://auth.example.com"] }`.
   */
  extraOrigins?: Readonly<Record<string, readonly string[]>>;
  /** The `fetch` shaped handles delegate to. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export interface HeaderCredentialProviderOptions extends CredentialPresetOptions {
  /** Plugin key a credential row's `plugin` column names. */
  key: string;
  /** Header the secret is sent in. */
  header: string;
  /** Joined to the secret with one space, e.g. `"Token"` sends `Token <secret>`. */
  prefix?: string;
}

/**
 * A provider whose handles send the secret, optionally prefixed, in `header`.
 * Handles are pinned to the credential's origin and never follow redirects.
 */
export function createHeaderCredentialProvider(
  opts: HeaderCredentialProviderOptions,
): CredentialProvider {
  const { prefix } = opts;
  return createPinnedProvider(opts.key, opts.header, opts, (secret) =>
    prefix ? `${prefix} ${secret}` : secret,
  );
}

/** Sends the secret verbatim in `x-api-key`. */
export function createXApiKeyCredentialProvider(
  opts: CredentialPresetOptions = {},
): CredentialProvider {
  return createPinnedProvider(
    X_API_KEY_PROVIDER_KEY,
    "x-api-key",
    opts,
    (secret) => secret,
  );
}

/** Sends the secret verbatim in `authorization`, with no `Bearer` prefix. */
export function createRawAuthorizationCredentialProvider(
  opts: CredentialPresetOptions = {},
): CredentialProvider {
  return createPinnedProvider(
    RAW_AUTHORIZATION_PROVIDER_KEY,
    "authorization",
    opts,
    (secret) => secret,
  );
}

/**
 * Sends `authorization: Bearer <secret>` to an MCP server, or no
 * `authorization` header when the stored secret is `MCP_NO_TOKEN_SENTINEL`.
 */
export function createMcpStreamableHttpCredentialProvider(
  opts: CredentialPresetOptions = {},
): CredentialProvider {
  return createPinnedProvider(
    MCP_STREAMABLE_HTTP_PROVIDER_KEY,
    "authorization",
    opts,
    (secret) =>
      secret === MCP_NO_TOKEN_SENTINEL ? undefined : `Bearer ${secret}`,
  );
}

function createPinnedProvider(
  key: string,
  header: string,
  opts: CredentialPresetOptions,
  format: (secret: string) => string | undefined,
): CredentialProvider {
  assertHeaderName(header);
  const fetchImpl: FetchLike = opts.fetch ?? globalThis.fetch;
  const extraOrigins = new Map(
    Object.entries(opts.extraOrigins ?? {}).map(([origin, extras]) => [
      new URL(origin).origin,
      extras,
    ]),
  );

  return {
    key,
    shape(context: CredentialShapeContext): HttpMediatedCredential {
      const origin = new URL(context.origin).origin;
      return {
        kind: "http",
        fetch: createOriginPinnedFetch({
          origin,
          header,
          readValue: () => {
            const { secret } = context.readCurrentMaterial();
            return secret === "" ? undefined : format(secret);
          },
          extraOrigins: extraOrigins.get(origin) ?? [],
          fetch: fetchImpl,
        }),
        dispose(): void {
          // An http handle allocates no resources; nothing to release.
        },
      };
    },
  };
}
