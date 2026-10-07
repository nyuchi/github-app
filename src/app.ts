// Authenticating as the Nyuchi App: the App JWT, installation lookups and
// installation tokens narrowed to what each job needs.
//
// The PEM handling (PKCS#1 -> PKCS#8) is the shared code from
// shamwari-ai/github-app, not a copy.

import { pemBody, pkcs1ToPkcs8 } from "shamwari-github-mcp/src/github";
import type { Env } from "./env";
import { readSecret } from "./env";

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const api = (env: Env) =>
  (env.GITHUB_API || "https://api.github.com").replace(/\/+$/, "");

const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let cachedKey: { pem: string; key: CryptoKey } | null = null;

async function signingKey(env: Env): Promise<CryptoKey> {
  const pem = await readSecret(env.APP_PRIVATE_KEY);
  if (!pem) throw new AppError("APP_PRIVATE_KEY is not bound or empty", 503);
  if (cachedKey && cachedKey.pem === pem) return cachedKey.key;
  const { der, pkcs1 } = pemBody(pem);
  const pkcs8 = pkcs1 ? pkcs1ToPkcs8(der) : der;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { pem, key };
  return key;
}

/** A nine-minute App JWT, `iat` backdated 60s for clock skew. */
export async function appJwt(env: Env, now = Date.now()): Promise<string> {
  const appId = (env.GITHUB_APP_ID || "").trim();
  if (!appId) throw new AppError("GITHUB_APP_ID is not set", 503);
  const t = Math.floor(now / 1000);
  const enc = new TextEncoder();
  const unsigned = `${b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${b64url(
    enc.encode(JSON.stringify({ iat: t - 60, exp: t + 540, iss: appId })),
  )}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await signingKey(env),
    enc.encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

export interface GhResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

/** One GitHub REST call. Throws AppError on a non-2xx, with GitHub's message. */
export async function gh(
  env: Env,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<GhResponse> {
  const url = path.startsWith("http") ? path : `${api(env)}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nyuchi-github-app",
    Authorization: `Bearer ${token}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new AppError(`${init.method || "GET"} ${path}: ${msg}`, res.status);
  }
  return { status: res.status, body, headers: res.headers };
}

/** GraphQL with an installation token. Throws on transport or query errors. */
export async function graphql<T>(
  env: Env,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const { body } = await gh(env, token, "/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  const b = body as { data?: T; errors?: { message: string }[] };
  if (b.errors?.length) {
    throw new AppError(
      `graphql: ${b.errors.map((e) => e.message).join("; ")}`,
      502,
    );
  }
  if (!b.data) throw new AppError("graphql: no data", 502);
  return b.data;
}

/** Follow `Link: rel="next"` for a REST list. `pick` extracts the rows. */
export async function paginate<T>(
  env: Env,
  token: string,
  path: string,
  pick: (body: unknown) => T[],
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let i = 0; next && i < maxPages; i++) {
    const res: GhResponse = await gh(env, token, next);
    out.push(...pick(res.body));
    const link = res.headers.get("link") || "";
    const m = /<([^>]+)>;\s*rel="next"/.exec(link);
    next = m ? m[1] : null;
  }
  return out;
}

export interface Installation {
  id: number;
  account: { login: string };
  suspended_at?: string | null;
}

/** Every installation of the App (JWT). */
export async function listInstallations(env: Env): Promise<Installation[]> {
  const jwt = await appJwt(env);
  return paginate(env, jwt, "/app/installations?per_page=100", (b) =>
    Array.isArray(b) ? (b as Installation[]) : [],
  );
}

/**
 * Parse "name:level,name:level" into the permissions object GitHub takes.
 * A token may request a SUBSET of what the App holds, never more.
 */
export function parsePermissions(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of spec.split(",")) {
    const [name, level] = pair.split(":").map((s) => s.trim());
    if (name && level) out[name] = level;
  }
  return out;
}

/** The narrow set the tagging job asks for. */
export const TAGGING_PERMISSIONS = parsePermissions(
  "contents:write,pull_requests:read,metadata:read",
);
/** The narrow set triage asks for. */
export const TRIAGE_PERMISSIONS = parsePermissions(
  "issues:write,metadata:read",
);

/** Mint an installation token, optionally limited to some repositories. */
export async function installationToken(
  env: Env,
  installationId: number,
  permissions: Record<string, string>,
  repositories?: string[],
): Promise<string> {
  const jwt = await appJwt(env);
  const { body } = await gh(
    env,
    jwt,
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        permissions,
        ...(repositories ? { repositories } : {}),
      }),
    },
  );
  const token = (body as { token?: string }).token;
  if (!token) throw new AppError("no token in the access_tokens response", 502);
  return token;
}
