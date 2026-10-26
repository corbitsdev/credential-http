// An origin-pinned, credential-injecting `fetch`: a fork of the handle
// `@intx/harness`'s `createHttpCredentialProvider` shapes, generalized to any
// header, an optional keyless request, and an explicit extra-origin allowlist.
// The protections are the same: every request is origin-checked before the
// credential is attached, and `redirect: "manual"` is forced so a 3xx is
// returned unfollowed rather than carrying the credential to another host.
// Transport is https, except http on loopback for a same-machine dev server.
// The URL is snapshotted to a string before headers, the credential, or fetch,
// and that string is what fetch is called with. A live URL or Request cannot
// move the host afterward.

import type { FetchLike } from "@intx/harness";

// RFC 9110 token and field-value. Errors never echo the value: it is a secret.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

// http is not a production credential transport. These hosts have no network
// hop; anything else (including other loopback addresses) stays refused.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/** Throw unless `name` is a valid HTTP header name. */
export function assertHeaderName(name: string): void {
  if (!HEADER_NAME.test(name)) {
    throw new Error(`invalid credential header name: ${JSON.stringify(name)}`);
  }
}

/**
 * Origin of `raw` when it is a credential transport we will send a secret to.
 * https is required. http is accepted only for loopback. `blob:` and every
 * other protocol are refused, even when their origin string matches the pin.
 */
export function credentialTransportOrigin(raw: string): string {
  const url = new URL(raw);
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    const label =
      url.protocol === "http:" || url.protocol === "https:"
        ? url.origin
        : url.href;
    throw new Error(
      `credential transport ${label} must be https (http is allowed only on loopback)`,
    );
  }
  return url.origin;
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
   * Each entry must be https, or http on loopback.
   */
  extraOrigins?: readonly string[];
  /** The `fetch` to delegate to. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Build a `fetch` that refuses any request outside the pinned origin (plus
 * `extraOrigins`), sets or strips `header`, and never follows a redirect.
 * A `Request` plus `RequestInit` keeps fetch's override rules: init replaces
 * request fields it sets, then the credential header and `redirect: "manual"`
 * are forced. The delegate receives the snapshotted URL string and that init,
 * never the caller's live `URL` or `Request`.
 */
export function createOriginPinnedFetch(
  opts: OriginPinnedFetchOptions,
): FetchLike {
  assertHeaderName(opts.header);
  const fetchImpl: FetchLike = opts.fetch ?? globalThis.fetch;
  const pinnedOrigin = credentialTransportOrigin(opts.origin);
  const allowed = new Set(
    (opts.extraOrigins ?? []).map((origin) =>
      credentialTransportOrigin(origin),
    ),
  );
  allowed.add(pinnedOrigin);

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Read the target once, before headers. A URL subclass can lie about
    // `origin`, and a Request `url` getter can change on the next read.
    const snapshot = snapshotHref(input, pinnedOrigin);
    const target = new URL(snapshot);
    if (!allowed.has(target.origin)) {
      throw crossOrigin(pinnedOrigin, target.origin);
    }
    // Allowlist entries were checked at construction. Check this URL's own
    // protocol, not `target.origin`: `blob:` URLs report the creator's origin.
    credentialTransportOrigin(snapshot);

    // Read init headers before the second URL read so a headers getter that
    // mutates `url.port` is visible. Do not touch `input.headers` yet: a
    // Request proxy's header getter brands `this` and would mask the move.
    const initHeaders = init?.headers;
    if (typeof input !== "string") {
      const current = snapshotHref(input, pinnedOrigin);
      if (current !== snapshot) {
        throw crossOrigin(pinnedOrigin, new URL(current).origin);
      }
    }

    const headers = new Headers(
      initHeaders !== undefined
        ? initHeaders
        : input instanceof Request
          ? input.headers
          : undefined,
    );

    const value = opts.readValue();
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

    return fetchImpl(snapshot, pinnedInit(input, init, headers));
  };
}

/**
 * Resolve the URL a request targets, as `@intx/harness` does: a relative
 * string resolves against the pinned origin, an absolute string or URL keeps
 * its own origin, and a `Request` already carries an absolute URL.
 * The result is a fresh href string, not the caller's object.
 */
function snapshotHref(
  input: string | URL | Request,
  pinnedOrigin: string,
): string {
  if (typeof input === "string") {
    return new URL(input, pinnedOrigin).href;
  }
  if (input instanceof URL) {
    return new URL(input.href).href;
  }
  return new URL(input.url).href;
}

/**
 * Keep fetch's override rules without handing fetch the live Request.
 * Init wins when it sets method, body, or signal; otherwise those come from
 * the Request. The credential header and `redirect: "manual"` are already
 * applied by the caller.
 */
function pinnedInit(
  input: string | URL | Request,
  init: RequestInit | undefined,
  headers: Headers,
): RequestInit {
  const next: RequestInit = { ...init, headers, redirect: "manual" };
  if (!(input instanceof Request)) {
    return next;
  }
  if (init?.method === undefined) {
    next.method = input.method;
  }
  if (init?.signal === undefined) {
    next.signal = input.signal;
  }
  if (
    init?.body === undefined &&
    next.method !== "GET" &&
    next.method !== "HEAD" &&
    input.body !== null
  ) {
    next.body = input.body;
  }
  return next;
}

function crossOrigin(pinnedOrigin: string, target: string): Error {
  return new Error(
    `credential is pinned to ${pinnedOrigin}; refusing cross-origin request to ${target}`,
  );
}
