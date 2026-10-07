// Types for the vendored org versioning policy (next-version.mjs), a
// byte-for-byte copy of nyuchi/.github at the commit in POLICY_SOURCE.
// test/policy-types.test.ts checks these names against the module itself.
export declare const CEILING: number;
export declare class PolicyError extends Error {}
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
  opts: {
    channel: "staging" | "main";
    allowMajor?: boolean;
    bump?: string;
    hasTags?: boolean;
  },
): string;
export declare function highest(
  refs: Iterable<string>,
  prefix?: string,
): string;
export declare function countTags(
  refs: Iterable<string>,
  prefix?: string,
): number;
