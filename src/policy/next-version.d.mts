// Types for the vendored org versioning policy (next-version.mjs), a
// byte-for-byte copy of nyuchi/.github at the commit in POLICY_SOURCE.
// test/policy-types.test.ts checks these names against the module both ways.
export declare const CEILING: number;
export declare const DEFAULT_PREFIX: string;
export declare class PolicyError extends Error {}
export declare class UsageError extends Error {}
/** THE version parser: MAJOR.MINOR.PATCH, each 0..999, nothing else. */
export declare function isStrictVersion(v: unknown): boolean;
export declare function parseStrict(v: string): {
  major: number;
  minor: number;
  patch: number;
};
export declare const parse: typeof parseStrict;
export declare function compare(a: string, b: string): number;
export declare function defaultBump(channel: "staging" | "main"): string;
export declare function nextVersion(
  current: string,
  opts: {
    channel: "staging" | "main";
    bump?: "" | "patch" | "minor" | "major";
    manual?: boolean;
  },
): string;
export declare function check(
  current: string,
  proposed: string,
  opts: { channel: "staging" | "main"; allowMajor?: boolean; bump?: string },
): string;
export declare function highest(
  refs: Iterable<string>,
  prefix?: string,
): string;
export declare function currentVersion(
  refs: string[],
  opts?: { prefix?: string; fromFiles?: string },
): { kind: string; version?: string; tagged?: string; written?: string };
export declare function decide(
  refs: string[],
  opts: {
    mode: "check" | "compute";
    channel: "staging" | "main";
    bump?: string;
    manual?: boolean;
    proposed?: string;
    fromFiles?: string;
    allowMajor?: boolean;
    prefix?: string;
  },
): unknown;
export declare function isMain(metaUrl: string, argv1?: string): boolean;
