# @corbits/credential-http

Credential providers that attach a secret to HTTP requests in any header: `x-api-key`, raw `authorization`, a custom prefix, or MCP streamable HTTP with a keyless mode. Each handle is pinned to the credential's origin and never follows a redirect. An auth and credentials package for Corbits that registers into the `@intx/harness` credential provider registry beside Interchange's built-in Bearer provider.

## Why @corbits/credential-http?

1. **Every header shape, one factory.** Interchange's built-in `http` provider sends only `authorization: Bearer <secret>`. `createHeaderCredentialProvider` takes the header name and an optional prefix, and three presets cover the common cases.
2. **The secret stays on its origin.** A handle refuses any request outside the credential's origin, re-reads the secret on every call so a rotation applies at once, and returns a 3xx to the caller unfollowed.
3. **Keyless MCP servers.** A public MCP server rejects a bogus bearer but accepts no header. The MCP preset sends no `authorization` header when the stored secret is `MCP_NO_TOKEN_SENTINEL`.

For plain Bearer APIs, use the built-in `http` provider from `@intx/harness`.

## Install

```bash
bun add @corbits/credential-http @intx/harness@^0.4.0 @intx/types@^0.4.0
```

Runs on Bun >= 1.2 or Node >= 24. The quickstart also uses `@intx/authz` for the grant.

## Quickstart

Needs `EXA_API_KEY` set. The tool gets a handle that sends the key in `x-api-key` to `https://api.exa.ai` and nowhere else.

```ts
import { toolConsumer } from "@intx/authz";
import {
  builtinCredentialProviders,
  createCredentialCapability,
  createCredentialProviderRegistry,
} from "@intx/harness";
import { createXApiKeyCredentialProvider } from "@corbits/credential-http";

const apiKey = process.env.EXA_API_KEY;
if (apiKey === undefined) throw new Error("EXA_API_KEY is not set");

const consumer = toolConsumer("@acme/search-tools");
const credentials = createCredentialCapability({
  consumer,
  providers: createCredentialProviderRegistry([
    ...builtinCredentialProviders(),
    createXApiKeyCredentialProvider(),
  ]),
  bindings: new Map([
    [
      "exa",
      {
        credentialId: "cred_exa",
        providerKey: "http-x-api-key",
        origin: "https://api.exa.ai",
        readCurrentMaterial: () => ({ secret: apiKey }),
      },
    ],
  ]),
  grants: [
    {
      id: "grt_exa",
      origin: "system",
      resource: "credential:cred_exa",
      action: "use",
      effect: "allow",
      conditions: { tool: consumer },
      expiresAt: null,
      roleId: null,
      principalId: null,
    },
  ],
});

const exa = await credentials.resolve("exa");
const response = await exa.fetch("/search", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "Interchange AI agents", numResults: 1 }),
});
console.log(response.status, await response.json());
```

## Where it fits

- **Interchange side:** any host that shapes tool credentials with `@intx/harness`: `createCredentialProviderRegistry` and `createCredentialCapability`.
- **Seam:** the `CredentialProvider` plugin from `@intx/types`. A credential row's provider `plugin` column names the provider key that shapes its handles.
- **Pairs with:** [`@corbits/mcp`](https://github.com/corbitsdev/corbits-mcp), which uses the MCP preset for tool calls and `createOriginPinnedFetch` for hub-side discovery.

## Reference

### Presets

| Factory                                            | Plugin key                                                  | Header sent                                                           |
| -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `createXApiKeyCredentialProvider(opts?)`           | `http-x-api-key` (`X_API_KEY_PROVIDER_KEY`)                 | `x-api-key: <secret>`                                                 |
| `createRawAuthorizationCredentialProvider(opts?)`  | `http-raw-authorization` (`RAW_AUTHORIZATION_PROVIDER_KEY`) | `authorization: <secret>`                                             |
| `createMcpStreamableHttpCredentialProvider(opts?)` | `mcp-streamable-http` (`MCP_STREAMABLE_HTTP_PROVIDER_KEY`)  | `authorization: Bearer <secret>`, or none for `MCP_NO_TOKEN_SENTINEL` |

`opts` is `CredentialPresetOptions`:

| Option         | Type                                | Default        |
| -------------- | ----------------------------------- | -------------- |
| `extraOrigins` | `Record<string, readonly string[]>` | `{}`           |
| `fetch`        | `FetchLike` from `@intx/harness`    | global `fetch` |

### `createHeaderCredentialProvider(opts)`

Any other header shape. `opts` adds `key` (the plugin key), `header`, and an optional `prefix` joined to the secret with one space.

```ts
createHeaderCredentialProvider({
  key: "http-token",
  header: "authorization",
  prefix: "Token",
});
```

### `createOriginPinnedFetch(opts)`

The pinned `fetch` every handle uses, for code that holds a secret outside the provider registry, such as a hub route. `opts` is `{ origin, header, readValue, extraOrigins?, fetch? }`. `readValue` runs per request; `undefined` or `""` sends no header.

### `MCP_NO_TOKEN_SENTINEL`

The secret to store for a keyless MCP server connection. Credential storage requires a non-empty secret; the MCP preset reads this value as "send no `authorization` header".

## Security

- **Origin pin.** A handle is pinned to `new URL(credential.origin).origin`. Relative paths resolve against it, and a request to any other origin throws before the secret is read.
- **`extraOrigins`.** Extra origins are keyed by the pinned origin, so one credential's allowance never applies to another. For example, `{ "https://mcp.example.com": ["https://auth.example.com"] }` lets only a credential pinned to `https://mcp.example.com` call `https://auth.example.com`.
- **`redirect: "manual"`.** Forced on every request. A 3xx comes back to the caller unfollowed, so a server cannot redirect the secret to another host.

## Using with Interchange

1. Register the providers you need next to the built-ins when you build the registry:

   ```ts
   const providers = createCredentialProviderRegistry([
     ...builtinCredentialProviders(),
     createXApiKeyCredentialProvider(),
     createMcpStreamableHttpCredentialProvider({
       extraOrigins: {
         "https://mcp.example.com": ["https://auth.example.com"],
       },
     }),
   ]);
   ```

2. Set the credential's provider row `plugin` column to the preset's key, for example `http-x-api-key`. Handles for that credential are then shaped by this package instead of the Bearer `http` provider.
3. For a keyless MCP server, store `MCP_NO_TOKEN_SENTINEL` as the credential's secret and use `mcp-streamable-http` as the plugin.
4. Grant the tool `credential:<id>` / `use`, as for any credential.

The stock Interchange 0.4 sidecar builds its registry from `builtinCredentialProviders()` only, so these providers apply in hosts that build their own registry.

## Upgrading from @corbits/credential-header / credential-mcp

`@corbits/credential-header` and `@corbits/credential-mcp` are merged into this package. Plugin keys, header shapes and the sentinel value are unchanged, so stored credential rows need no migration.

Two behaviors change. An empty secret now sends no header from every preset; `credential-header` used to send an empty one. The cross-origin error now reads `credential is pinned to <origin>; refusing cross-origin request to <origin>`, without the provider key.

| Before                                                                                                                  | After                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `@corbits/credential-header`, `@corbits/credential-mcp`                                                                 | `@corbits/credential-http`                                                                                                                   |
| `xApiKeyCredentialProvider(opts?)`                                                                                      | `createXApiKeyCredentialProvider(opts?)`                                                                                                     |
| `rawAuthorizationCredentialProvider(opts?)`                                                                             | `createRawAuthorizationCredentialProvider(opts?)`                                                                                            |
| `createHeaderCredentialProvider({ key, header, prefix?, fetch? })`                                                      | unchanged, plus `extraOrigins?`                                                                                                              |
| `createMcpStreamableHttpCredentialProvider(opts?)`                                                                      | unchanged, plus `extraOrigins?`                                                                                                              |
| `HeaderPresetOptions`, `McpStreamableHttpCredentialProviderOptions`                                                     | `CredentialPresetOptions`                                                                                                                    |
| `X_API_KEY_PROVIDER_KEY`, `RAW_AUTHORIZATION_PROVIDER_KEY`, `MCP_STREAMABLE_HTTP_PROVIDER_KEY`, `MCP_NO_TOKEN_SENTINEL` | unchanged                                                                                                                                    |
| `mcpOriginPinnedFetch({ pinnedOrigin, readToken, fetch? })`                                                             | `createOriginPinnedFetch({ origin, header: "authorization", readValue, fetch? })`, where `readValue` returns `Bearer <token>` or `undefined` |
| `McpOriginPinnedFetchArgs`                                                                                              | `OriginPinnedFetchOptions`                                                                                                                   |
| `FetchLike`                                                                                                             | import from `@intx/harness`                                                                                                                  |
| `resolveMcpTargetUrl`, `assertMcpPinnedTarget`                                                                          | removed; `createOriginPinnedFetch` does both                                                                                                 |
| Built-in provider-specific cross-origin allowance                                                                       | pass `extraOrigins: { "https://mcp.example.com": ["https://auth.example.com"] }`                                                             |

## License

LGPL-2.1-only. See [LICENSE](LICENSE).
