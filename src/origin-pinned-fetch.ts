// An origin-pinned, credential-injecting `fetch`: a fork of the handle
// `@intx/harness`'s `createHttpCredentialProvider` shapes, generalized to any
// header, an optional keyless request, and an explicit extra-origin allowlist.
// The protections are the same: every request is origin-checked before the
// credential is attached, and `redirect: "manual"` is forced so a 3xx is
// returned unfollowed rather than carrying the credential to another host.

import type { FetchLike } from "@intx/harness";

// RFC 9110 token and field-value. Errors never echo the value: it is a secret.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Throw unless `name` is a valid HTTP header name. */
export function assertHeaderName(name: string): void {
  if (!HEADER_NAME.test(name)) {
    throw new Error(`invalid credential header name: ${JSON.stringify(name)}`);
  }
}

export interface OriginPinnedFetchOptions {
  /** Origin every request must target. A full URL is reduced to its origin. */
  origin: string;
  /** Header the credential is sent in. */
  header: string;
  /**
   * Reads the header value on every request, so a rotated secret is picked up
   * without a rebuild. `undefined` or `""` sends the request without the
   * header.
   */
  readValue: () => string | undefined;
  /**
   * Further origins a request may target, for a server whose protocol origin
   * differs from its stored URL. A redirect to one is still never followed.
   */
  extraOrigins?: readonly string[];
  /** The `fetch` to delegate to. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Build a `fetch` that refuses any request outside the pinned origin (plus
 * `extraOrigins`), sets or strips `header`, and never follows a redirect.
 */
export function createOriginPinnedFetch(
  opts: OriginPinnedFetchOptions,
): FetchLike {
  assertHeaderName(opts.header);
  const fetchImpl: FetchLike = opts.fetch ?? globalThis.fetch;
  const pinnedOrigin = new URL(opts.origin).origin;
  const allowed = new Set(
    (opts.extraOrigins ?? []).map((origin) => new URL(origin).origin),
  );
  allowed.add(pinnedOrigin);

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const target = resolveTargetUrl(input, pinnedOrigin);
    if (!allowed.has(target.origin)) {
      throw new Error(
        `credential is pinned to ${pinnedOrigin}; refusing cross-origin request to ${target.origin}`,
      );
    }

    const value = opts.readValue();
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    if (value === undefined || value === "") {
      headers.delete(opts.header);
    } else {
      if (!HEADER_VALUE.test(value)) {
        throw new Error(
          `credential value for ${opts.header} is not a valid header value`,
        );
      }
      headers.set(opts.header, value);
    }

    if (input instanceof Request) {
      return fetchImpl(new Request(input, { headers, redirect: "manual" }));
    }
    return fetchImpl(target, { ...init, headers, redirect: "manual" });
  };
}

/**
 * Resolve the URL a request targets, as `@intx/harness` does: a relative
 * string resolves against the pinned origin, an absolute string or URL keeps
 * its own origin, and a `Request` already carries an absolute URL.
 */
function resolveTargetUrl(
  input: string | URL | Request,
  pinnedOrigin: string,
): URL {
  if (typeof input === "string") {
    return new URL(input, pinnedOrigin);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}
