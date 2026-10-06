#!/usr/bin/env node
// The org's versioning policy, in one place.
//
//   Merge into `staging`      PATCH  x.y.z -> x.y.(z+1)
//   Release `staging` -> main MINOR  x.y.z -> x.(y+1).0
//   MAJOR                     manual only (workflow_dispatch, bump: major)
//
// Each segment holds 0..999. PATCH 999 rolls into the next MINOR
// (x.y.999 -> x.(y+1).0). MINOR 999 does NOT roll into a MAJOR: that is
// refused, and a person runs the major release by hand.
//
// No dependencies, so it runs on any runner with Node and in the tests.
//
// Usage
//   next-version.mjs next    --current 0.27.3 --channel staging|main
//                            [--bump patch|minor|major] [--manual]
//     Prints the next version.
//   next-version.mjs check   --current 0.27.3 --proposed 0.28.0
//                            --channel staging|main [--allow-major]
//     Exits 0 when a version written into the repo is what the policy
//     allows next; prints why not and exits 1 otherwise.
//   next-version.mjs highest [--prefix v]   (tag refs on stdin)
//     Prints the highest released version among the tags, or 0.0.0.

import { pathToFileURL } from "node:url";

export const CEILING = 999;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export class PolicyError extends Error {}

export function parse(version) {
  const m = SEMVER.exec(String(version).trim());
  if (!m) throw new PolicyError(`'${version}' is not a semantic version.`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ?? "",
  };
}

const core = (v) => `${v.major}.${v.minor}.${v.patch}`;

export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/** The bump a channel takes when nobody overrides it. */
export function defaultBump(channel) {
  if (channel === "staging") return "patch";
  if (channel === "main") return "minor";
  throw new PolicyError(
    `Unknown channel '${channel}'; expected 'staging' or 'main'.`,
  );
}

/**
 * The next version after `current`.
 * @param {string} current  highest version released so far ("" = none yet)
 * @param {object} opts
 * @param {"staging"|"main"} opts.channel
 * @param {""|"patch"|"minor"|"major"} [opts.bump]  override (manual runs)
 * @param {boolean} [opts.manual]  a person started this run; required for major
 */
export function nextVersion(current, { channel, bump = "", manual = false }) {
  const kind = bump || defaultBump(channel);
  const v = parse(current || "0.0.0");

  if (kind === "major") {
    if (!manual) {
      throw new PolicyError(
        "A major version is only ever released by hand: run the release " +
          "workflow from the Actions tab with bump: major.",
      );
    }
    if (v.major + 1 > CEILING) {
      throw new PolicyError(`Major is already ${CEILING}; there is no next.`);
    }
    return `${v.major + 1}.0.0`;
  }

  if (kind === "patch") {
    if (v.patch + 1 <= CEILING) return `${v.major}.${v.minor}.${v.patch + 1}`;
    // x.y.999 -> x.(y+1).0, through the same ceiling check as a minor.
    return bumpMinor(v, `Patch ${core(v)} is at ${CEILING} and rolls into`);
  }

  if (kind === "minor") return bumpMinor(v, `Minor bump from ${core(v)} needs`);

  throw new PolicyError(
    `Unknown bump '${bump}'; expected patch, minor or major.`,
  );
}

function bumpMinor(v, why) {
  if (v.minor + 1 > CEILING) {
    throw new PolicyError(
      `${why} the next minor, but minor is at ${CEILING} and never rolls ` +
        `into a major on its own. Release ${v.major + 1}.0.0 by hand: run ` +
        "the release workflow from the Actions tab with bump: major.",
    );
  }
  return `${v.major}.${v.minor + 1}.0`;
}

/**
 * Whether `proposed` (a version written into the repo) is allowed after
 * `current` (the highest tag). Returns the reason it is allowed; throws a
 * PolicyError naming the allowed version when it is not.
 */
export function check(
  current,
  proposed,
  { channel, allowMajor = false, bump = "" },
) {
  const p = parse(proposed);
  if (!current || current === "0.0.0") return "first release";
  if (compare(core(p), current) === 0) return "unchanged";

  const major = `${parse(current).major + 1}.0.0`;
  if (allowMajor && core(p) === major) return "next major";

  // The usual next version; at minor 999 there is none, and that error
  // (which asks for a manual major) is the answer.
  const allowed = nextVersion(current, { channel, bump, manual: allowMajor });
  if (core(p) === allowed) return `next ${bump || defaultBump(channel)}`;

  const hint =
    core(p) === major && !allowMajor
      ? " A major version is released by hand: run the workflow from the " +
        "Actions tab with bump: major."
      : "";
  throw new PolicyError(
    `Version ${proposed} is not allowed after ${current} on ${channel}: the ` +
      `policy allows ${allowed}.${hint}`,
  );
}

/** Highest released version (no pre-release) among tag names or refs. */
export function highest(refs, prefix = "v") {
  let best = "0.0.0";
  for (const line of refs) {
    const ref = line
      .trim()
      .split(/\s+/)
      .pop()
      ?.replace(/^refs\/tags\//, "")
      .replace(/\^\{\}$/, "");
    if (!ref || !ref.startsWith(prefix)) continue;
    let v;
    try {
      v = parse(ref.slice(prefix.length));
    } catch {
      continue;
    }
    if (v.pre) continue;
    if (compare(core(v), best) > 0) best = core(v);
  }
  return best;
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (a === "--manual" || a === "--allow-major") {
      // A bare flag is true; an explicit value after it is consumed.
      const v = argv[i + 1];
      out[a.slice(2)] = v === "true" || v === "false" ? argv[++i] : true;
    } else out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

async function stdinLines() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.split("\n");
}

async function main(argv) {
  const a = args(argv);
  const truthy = (x) => x === true || x === "true";
  switch (a._[0]) {
    case "next":
      return nextVersion(a.current ?? "", {
        channel: a.channel,
        bump: a.bump ?? "",
        manual: truthy(a.manual),
      });
    case "check":
      return check(a.current ?? "", a.proposed, {
        channel: a.channel,
        bump: a.bump ?? "",
        allowMajor: truthy(a["allow-major"]),
      });
    case "highest":
      return highest(await stdinLines(), a.prefix ?? "v");
    default:
      throw new PolicyError("Usage: next-version.mjs next|check|highest ...");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (out) => console.log(out),
    (err) => {
      const msg = err instanceof PolicyError ? err.message : err.stack;
      console.error(process.env.GITHUB_ACTIONS ? `::error::${msg}` : msg);
      process.exit(1);
    },
  );
}
