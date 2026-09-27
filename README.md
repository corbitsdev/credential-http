# @corbits/credential-http

Send a credential in any HTTP header, only to its own origin. Presets cover `x-api-key`, raw `authorization` and MCP streamable HTTP, and they register into the `@intx/harness` credential registry beside Interchange's built-in Bearer provider.

## Why @corbits/credential-http?

1. **Every header shape, one factory.** Interchange's built-in `http` provider sends only `authorization: Bearer <secret>`. `createHeaderCredentialProvider` takes the header name and an optional prefix, and three presets cover the common cases.
2. **The secret stays on its origin.** A handle refuses any request outside the credential's origin, re-reads the secret on every call so a rotation applies at once, and never follows a redirect.
3. **Keyless MCP servers.** A public MCP server rejects a bogus bearer but accepts no header. The MCP preset sends no `authorization` header when the stored secret is `MCP_NO_TOKEN_SENTINEL`.

For plain Bearer APIs, use the built-in `http` provider from `@intx/harness`.

## Install

```bash
bun add @corbits/credential-http @intx/harness@^0.4.0 @intx/types@^0.4.0
```

Runs on Bun >= 1.2 or Node >= 24.

## Quickstart

Four steps: register the preset in your host, then create the provider, the credential and the grant through the Interchange hub. The example sends an API key in `x-api-key` to `https://api.example.com`.

**1. Register the preset** where your host builds its credential registry.

```ts
import {
  builtinCredentialProviders,
  createCredentialProviderRegistry,
} from "@intx/harness";
import { createXApiKeyCredentialProvider } from "@corbits/credential-http";

const providers = createCredentialProviderRegistry([
  ...builtinCredentialProviders(),
  createXApiKeyCredentialProvider(),
]);
```

**2. Create the provider.** `plugin` picks the preset; `apiBaseUrl` is the only origin the key is ever sent to.

```sh
curl -X POST "$HUB_URL/api/tenants/$TENANT_ID/providers" \
  -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name": "example", "plugin": "http-x-api-key", "apiBaseUrl": "https://api.example.com"}'
```

**3. Store the key** under that provider, using the `id` from step 2.

```sh
curl -X POST "$HUB_URL/api/tenants/$TENANT_ID/credentials" \
  -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"providerId": "'"$PROVIDER_ID"'", "name": "example", "type": "api_key", "secret": "'"$API_KEY"'"}'
```

**4. Let the agent use it**, using the credential `id` from step 3.

```sh
curl -X POST "$HUB_URL/api/tenants/$TENANT_ID/grants" \
  -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"principalId": "'"$AGENT_PRINCIPAL_ID"'", "resource": "credential:'"$CREDENTIAL_ID"'", "action": "use", "effect": "allow", "origin": "system"}'
```

The agent's tools now get a handle that sends the key in `x-api-key` to `https://api.example.com` and refuses any other origin.

## Where it fits

- **Seam:** the `CredentialProvider` plugin from `@intx/types`. A provider's `plugin` field names the preset that shapes its credentials' handles.
- **Pairs with:** [`@corbits/mcp`](https://github.com/corbitsdev/corbits-mcp), which uses the MCP preset for tool calls and `createOriginPinnedFetch` for hub-side discovery.

## Reference

### Presets

| Factory                                            | Plugin key               | Header sent                                                           |
| -------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `createXApiKeyCredentialProvider(opts?)`           | `http-x-api-key`         | `x-api-key: <secret>`                                                 |
| `createRawAuthorizationCredentialProvider(opts?)`  | `http-raw-authorization` | `authorization: <secret>`                                             |
| `createMcpStreamableHttpCredentialProvider(opts?)` | `mcp-streamable-http`    | `authorization: Bearer <secret>`, or none for `MCP_NO_TOKEN_SENTINEL` |

The keys are also exported as `X_API_KEY_PROVIDER_KEY`, `RAW_AUTHORIZATION_PROVIDER_KEY` and `MCP_STREAMABLE_HTTP_PROVIDER_KEY`.

`opts` is `CredentialPresetOptions`:

| Option         | Type                                | Default        |
| -------------- | ----------------------------------- | -------------- |
| `extraOrigins` | `Record<string, readonly string[]>` | `{}`           |
| `fetch`        | `FetchLike` from `@intx/harness`    | global `fetch` |

`extraOrigins` is keyed by the pinned origin, so one credential's allowance never applies to another. `{ "https://mcp.example.com": ["https://auth.example.com"] }` lets only a credential pinned to `https://mcp.example.com` also call `https://auth.example.com`.

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

The secret to store for a keyless MCP server. Credential storage requires a non-empty secret; the MCP preset reads this value as "send no `authorization` header".

## Using with Interchange

- The stock Interchange 0.4 sidecar builds its registry from `builtinCredentialProviders()` only. These presets apply in hosts that build their own registry, as in step 1.
- For a keyless MCP server, create the provider with `plugin: "mcp-streamable-http"` and store `MCP_NO_TOKEN_SENTINEL` as the credential's secret.

## Upgrading from @corbits/credential-header / credential-mcp

Both packages are merged into this one. Plugin keys, header shapes and the sentinel are unchanged, so stored credentials need no migration. An empty secret now sends no header, where `credential-header` sent an empty one.

| Before                                                              | After                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `xApiKeyCredentialProvider`                                         | `createXApiKeyCredentialProvider`                                                 |
| `rawAuthorizationCredentialProvider`                                | `createRawAuthorizationCredentialProvider`                                        |
| `mcpOriginPinnedFetch({ pinnedOrigin, readToken, fetch? })`         | `createOriginPinnedFetch({ origin, header: "authorization", readValue, fetch? })` |
| `HeaderPresetOptions`, `McpStreamableHttpCredentialProviderOptions` | `CredentialPresetOptions`                                                         |
| Built-in cross-origin allowance for one MCP provider                | `extraOrigins`                                                                    |

`FetchLike` now comes from `@intx/harness`, and `resolveMcpTargetUrl` and `assertMcpPinnedTarget` are removed because `createOriginPinnedFetch` does both.

## License

LGPL-2.1-only. See [LICENSE](LICENSE).
