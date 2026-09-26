# AGENTS.md

## Purpose

`@corbits/credential-http` holds Interchange credential providers that
authenticate HTTP requests in shapes the built-in `http` (Bearer) provider in
`@intx/harness` does not: any header, `x-api-key`, raw `authorization`, and
MCP streamable HTTP with a keyless mode. It owns how a handle attaches a
secret. It does not store, resolve or authorize credentials; the host and
`@intx/harness` do that before a provider is called.

## Layout

- `src/origin-pinned-fetch.ts` — `createOriginPinnedFetch`, the origin check,
  header injection and forced `redirect: "manual"` every handle uses.
- `src/credential-providers.ts` — `createHeaderCredentialProvider`, the three
  presets, their plugin keys and `MCP_NO_TOKEN_SENTINEL`.
- `src/index.ts` — the only module consumers import from.
- `e2e/` — providers registered in a real `@intx/harness` registry and
  capability, against local servers.

## Rules

- Mirror `@intx/harness`'s `createHttpCredentialProvider`: pin to the
  credential origin, read the secret per request, never follow a redirect.
  The only deviations are the ones the header shapes need: a configurable
  header, host-supplied extra origins, and no header for an empty or keyless
  secret.
- Extra origins are host-supplied and keyed by the pinned origin. No vendor
  origin lives in source.
- `FetchLike` comes from `@intx/harness`; do not redeclare it.

## Local development

```sh
bun install
bun run check
bun run test:e2e
```
