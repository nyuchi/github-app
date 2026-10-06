import { generateKeyPairSync, createHmac } from "node:crypto";
import type { Env } from "../src/env";

export const PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export const secret = (v: string | undefined) => ({
  get: async () => {
    if (v === undefined) throw new Error("secret not found");
    return v;
  },
});

export const WEBHOOK_SECRET = "test-webhook-secret";

export function testEnv(over: Partial<Env> = {}): Env {
  return {
    APP_PRIVATE_KEY: secret(PEM),
    APP_WEBHOOK_SECRET: secret(WEBHOOK_SECRET),
    GITHUB_APP_ID: "4980118",
    GITHUB_API: "https://api.github.test",
    ALLOWED_ORGS:
      "bundu-labs,mukoko-dev,mzizi-dev,nyuchi,openNTL,shamwari-ai,siafuDB",
    TAGGING_MODE: "dry-run",
    BACKFILL_SINCE: "2026-09-01T00:00:00Z",
    ...over,
  };
}

export function sign(body: string, key = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

export interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Replace global fetch with a router; returns the calls made. */
export function mockFetch(
  route: (
    method: string,
    url: string,
    body: unknown,
  ) => { status?: number; body: unknown; headers?: Record<string, string> },
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const r = route(method, url, body);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

export const waits: Promise<unknown>[] = [];
export const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
