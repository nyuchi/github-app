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
// ONE STRICT VERSION FORMAT (nyuchi/.github#90). A version is exactly
//
//   MAJOR.MINOR.PATCH    each 0..999, decimal, no leading zeros
//
// and nothing else: no "v", no whitespace, no pre-release (-rc.1), no build
// metadata (+b), no fourth segment. parseStrict() / isStrictVersion() below
// are the only parser, used by every function here, by read-version.mjs
// (release-version-check) and by the Nyuchi App (nyuchi/github-app), so no
// two of them can read a version differently. Anything else is rejected:
// the checks fail closed. A tag is a version tag only when its name is the
// prefix plus a strict version; every other tag is ignored.
//
// version-fixtures.json beside this file is the shared table of examples
// that every implementation is tested against. Its format is stable:
//
//   [ { "input": "<string, verbatim>", "valid": true | false }, ... ]
//
// A JSON array of objects with exactly those two keys; `valid` is what
// isStrictVersion(input) returns. The Nyuchi App fetches the file at the
// commit it pins and runs its own classifier over it.
//
// No dependencies, so it runs on any runner with Node and in the tests.
//
// Usage
//   next-version.mjs decide  --mode check|compute --channel staging|main
//                            [--bump patch|minor|major] [--manual]
//                            [--proposed <x.y.z>] [--from-files <x.y.z>]
//                            [--allow-major] [--prefix v]
//                            (ALL tag refs on stdin, not prefix-filtered)
//     THE decision, used by both composite actions (release-version-check
//     and next-version): prints one line, "ok <version> <current> <reason>",
//     or fails with the reason. See decide(). In check mode --from-files is
//     the version BEFORE the change, never the proposed one.
//
//   Exit codes: 0 an answer; 2 the policy says no (stderr "policy: <reason>");
//   1 a bad call or a crash. Callers treat anything but 0 and 2 as a hard
//   error.
//   next-version.mjs next    --current 0.27.3 --channel staging|main
//                            [--bump patch|minor|major] [--manual]
//     Prints the next version after a known current one.
//   next-version.mjs check   --current 0.27.3 --proposed 0.28.0
//                            --channel staging|main [--allow-major]
//     Exits 0 with the reason when a version written into the repo is what
//     the policy allows after a known current one; fails otherwise.
//   next-version.mjs current [--from-files <x.y.z>] [-- <prefix>]
//                            (ALL tag refs on stdin)
//     The current version alone, one line: "tagged <x.y.z>", "untagged",
//     "written <x.y.z>" or "none". See currentVersion().
//   next-version.mjs tags-path --repo <owner/repo> -- <prefix>
//     The tags API path decide needs: all tags for the default prefix (or
//     ""), else the prefix's own (each segment URL-encoded, slashes kept).
//   next-version.mjs strict  --version <v>
//     Prints the version rebuilt from its parts (so equal to <v>) when <v>
//     is strict; fails otherwise. Callers compare the output with <v>.
//
// Tag refs on stdin are one per line: "refs/tags/<name>", "<name>", or
// "<sha>\t<ref>" (ls-remote). Nothing is trimmed.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CEILING = 999;

// The only version pattern. `\d` without the u flag is ASCII 0-9 only.
const STRICT = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

/** The policy says no (exit 2 from the CLI, "policy: <reason>"). */
export class PolicyError extends Error {}

/** The call itself is wrong: a bad flag, mode or channel (exit 1). */
export class UsageError extends Error {}

/** Whether `v` is exactly MAJOR.MINOR.PATCH (each 0..999). */
export function isStrictVersion(v) {
  return typeof v === "string" && STRICT.test(v);
}

/** { major, minor, patch } of a strict version; PolicyError otherwise. */
export function parseStrict(v) {
  const m = typeof v === "string" ? STRICT.exec(v) : null;
  if (!m) {
    throw new PolicyError(
      `${JSON.stringify(v) ?? String(v)} is not a version: expected ` +
        "MAJOR.MINOR.PATCH, each 0..999, nothing else.",
    );
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** The same parser under its old name. */
export const parse = parseStrict;

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
  throw new UsageError(
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

  throw new UsageError(
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
  // Strict, like everything else: a pre-release or build suffix is refused.
  // From 0.0.0 (a first release) the rule is the same: 0.0.1 on staging,
  // 0.1.0 on main, or 1.0.0 with allowMajor; anything else is refused.
  const p = parse(proposed);
  current = current || "0.0.0";
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

/** The tag name in a ref line: "<name>", "refs/tags/<name>", "<sha>\t<ref>". */
function tagName(line) {
  return String(line)
    .slice(String(line).lastIndexOf("\t") + 1)
    .replace(/^refs\/tags\//, "")
    .replace(/\^\{\}$/, "");
}

/**
 * The versions of the tags whose name is exactly <prefix><strict version>.
 * Nothing is trimmed, so a tag that is not exactly a version tag is ignored.
 */
function tagVersions(refs, prefix) {
  const out = [];
  for (const line of refs) {
    const ref = tagName(line);
    if (!ref.startsWith(prefix)) continue;
    const v = ref.slice(prefix.length);
    if (isStrictVersion(v)) out.push(v);
  }
  return out;
}

/** Highest version among the version tags, or 0.0.0. */
export function highest(refs, prefix = "v") {
  let best = "0.0.0";
  for (const v of tagVersions(refs, prefix)) {
    if (compare(v, best) > 0) best = v;
  }
  return best;
}

export const DEFAULT_PREFIX = "v";

/**
 * The current version of a repo: the one rule.
 *
 *   { kind: "tagged", version }   the highest <prefix><strict version> tag,
 *                                 at least as high as the files
 *   { kind: "written", version, tagged? }
 *                                 the version the repo writes (`fromFiles`),
 *                                 when there is no version tag, or the files
 *                                 are ahead of the tags (a hand bump, or a
 *                                 tag not made yet; `tagged` is the highest
 *                                 tag): never a deadlock
 *   { kind: "untagged", written } DEFAULT PREFIX ONLY: tags exist, but none
 *                                 is a version tag (another scheme,
 *                                 pre-releases only, out of range), so no
 *                                 written version can be verified;
 *                                 `written` is the files' version or ""
 *   { kind: "none" }              nothing: a true first release from 0.0.0
 *
 * With any other prefix (a monorepo component such as `web-v`, or ""), a tag
 * that is not exactly <prefix><strict version> is ignored as if absent, so a
 * component whose only tag is web-v1.0.0-rc.1 has a normal first release.
 *
 * @param {string[]} refs  ALL tag refs (or, for another prefix, at least
 *   that prefix's); blank lines are ignored
 * @param {{prefix?: string, fromFiles?: string}} opts  `fromFiles`, when
 *   given, must be a strict version; 0.0.0 is a placeholder (nothing)
 */
export function currentVersion(
  refs,
  { prefix = DEFAULT_PREFIX, fromFiles = "" } = {},
) {
  const tags = refs.filter((r) => String(r) !== "");
  if (
    fromFiles !== "" &&
    fromFiles !== undefined &&
    !isStrictVersion(fromFiles)
  ) {
    // A bad call, not a policy answer (exit 1 from the CLI).
    throw new UsageError(
      `--from-files ${JSON.stringify(fromFiles)} is not a version: expected MAJOR.MINOR.PATCH.`,
    );
  }
  const written = fromFiles && fromFiles !== "0.0.0" ? fromFiles : "";
  const versions = tagVersions(tags, prefix);
  if (versions.length > 0) {
    const tagged = highest(versions, "");
    if (written && compare(written, tagged) > 0) {
      return { kind: "written", version: written, tagged };
    }
    return { kind: "tagged", version: tagged };
  }
  if (prefix === DEFAULT_PREFIX && tags.length > 0) {
    return { kind: "untagged", written };
  }
  if (written) return { kind: "written", version: written };
  return { kind: "none" };
}

/**
 * THE decision, the only one: release-version-check and the next-version
 * action both act on its answer alone.
 *
 *   mode "check"    `proposed` is the version written into the repo. It is
 *                   allowed when it equals the current version and is
 *                   already tagged, or when check() allows it after the
 *                   current version; anything else is refused, a
 *                   downgrade to an old tag included. An untagged repo
 *                   (default prefix) cannot be verified: refused.
 *   mode "compute"  when `fromFiles` holds a real version (not 0.0.0) above
 *                   every version tag (no tag, or an untagged repo, counts
 *                   as below), the answer is the files' version itself: the
 *                   release they announce. Compute trusts the PR check (and
 *                   its label) or an owner bypass that put it there. A
 *                   manual run with an explicit `bump` overrides that and
 *                   bumps from max(tag, files). Otherwise it bumps from the
 *                   highest tag (0.0.1 / 0.1.0 with none).
 *
 * In check mode the current version is currentVersion(): the higher of the
 * highest version tag and `fromFiles`, the version BEFORE the change. A
 * major needs `allowMajor` (the semver:major label) in check mode, or a
 * manual run with bump: major.
 *
 * @returns {{version: string, current: string, reason: string}}
 * @throws {PolicyError} with the reason, when the answer is no
 */
export function decide(
  refs,
  {
    mode,
    channel,
    bump = "",
    manual = false,
    proposed = "",
    fromFiles = "",
    allowMajor = false,
    prefix = DEFAULT_PREFIX,
  },
) {
  if (channel !== "staging" && channel !== "main") {
    throw new UsageError(
      `Unknown channel '${channel}'; expected staging or main.`,
    );
  }
  if (!["", "patch", "minor", "major"].includes(bump)) {
    throw new UsageError(
      `Unknown bump '${bump}'; expected patch, minor or major.`,
    );
  }
  if (mode !== "check" && mode !== "compute") {
    throw new UsageError(`Unknown mode '${mode}'; expected check or compute.`);
  }
  if (
    fromFiles !== "" &&
    fromFiles !== undefined &&
    !isStrictVersion(fromFiles)
  ) {
    throw new UsageError(
      `--from-files ${JSON.stringify(fromFiles)} is not MAJOR.MINOR.PATCH.`,
    );
  }
  if (mode === "check" && (proposed === "" || proposed === undefined)) {
    throw new UsageError("decide --mode check needs --proposed.");
  }
  const major = allowMajor || (manual && bump === "major");
  const cur = currentVersion(refs, { prefix, fromFiles });
  const current = cur.version ?? "0.0.0";
  const from = {
    tagged: `the highest tag ${prefix}${current}`,
    written: `the version the repo writes, ${current}`,
    untagged: "no version tag",
    none: "nothing yet",
  }[cur.kind];
  const first = cur.kind === "none" ? "first release, " : "";

  if (mode === "check") {
    parseStrict(proposed);
    // In check mode the files' version is the one BEFORE the change. Equal
    // to the proposed one it would make itself current and pass as
    // "unchanged" -- unless it is the current tag already (a caller whose
    // parent and head are the same commit).
    const tagged = cur.kind === "tagged" && proposed === current;
    if (fromFiles && fromFiles === proposed && !tagged) {
      throw new UsageError(
        "--from-files must be the version before the change, not the proposed one.",
      );
    }
    if (cur.kind === "untagged") {
      throw new PolicyError(
        `This repo's tags don't follow ${prefix}<MAJOR.MINOR.PATCH>, so the ` +
          `version can't be verified; tag releases as ${prefix}<version>.`,
      );
    }
    if (tagged) {
      return {
        version: proposed,
        current,
        reason: `already tagged ${prefix}${proposed}`,
      };
    }
    const why = check(current, proposed, { channel, bump, allowMajor: major });
    return {
      version: proposed,
      current,
      reason: `${first}${why} (current: ${from})`,
    };
  }

  // Compute. ONE rule: files that hold a real version above every version
  // tag (no tag counts as below) are the answer, the release they announce;
  // they reached the branch through the required check (with its label) or
  // an owner bypass. A manual run with an explicit bump overrides that and
  // bumps from max(tag, files). Otherwise: bump from the highest tag.
  const files = fromFiles && fromFiles !== "0.0.0" ? fromFiles : "";
  const tag = cur.kind === "tagged" ? cur.version : (cur.tagged ?? "");
  const override = manual && bump !== "";
  if (files && !override && (!tag || compare(files, tag) > 0)) {
    return {
      version: files,
      current: tag || "0.0.0",
      reason: tag
        ? `the version the repo writes, ahead of the highest tag ${prefix}${tag}`
        : `the version the repo writes (no version tag yet)`,
    };
  }
  const fromFilesBase = files && (!tag || compare(files, tag) > 0);
  const base = fromFilesBase ? files : tag || "0.0.0";
  const version = nextVersion(base, { channel, bump, manual });
  const kind = bump || defaultBump(channel);
  const baseFrom = fromFilesBase
    ? `the version the repo writes, ${base}`
    : tag
      ? `the highest tag ${prefix}${tag}`
      : cur.kind === "untagged"
        ? "no version tag"
        : "nothing yet";
  return {
    version,
    current: base,
    reason: `${first}next ${kind} (current: ${baseFrom})`,
  };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      // Everything after -- is a positional argument, even "-x" or "--x".
      out._.push(...argv.slice(i + 1));
      break;
    } else if (!a.startsWith("--")) out._.push(a);
    else if (a === "--manual" || a === "--allow-major") {
      // Exactly "true" or "false"; a bare flag (last, or before another
      // --flag) is true. Anything else is refused, never read as true.
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) out[a.slice(2)] = true;
      else if (v === "true" || v === "false") out[a.slice(2)] = argv[++i];
      else throw new UsageError(`${a} takes true or false, not '${v}'.`);
    } else {
      // A value flag takes the next argument, which must not be a flag.
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new UsageError(`${a} needs a value.`);
      }
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

/**
 * The tag prefix: the one positional argument after --, or --prefix
 * (which cannot start with --), or the default.
 */
function prefixArg(a) {
  if (a._.length > 2) throw new UsageError("Only one argument after --.");
  if (a._.length === 2) {
    if (a.prefix !== undefined) {
      throw new UsageError(
        "Give the prefix after -- or as --prefix, not both.",
      );
    }
    return a._[1];
  }
  return a.prefix ?? DEFAULT_PREFIX;
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
    case "decide": {
      const d = decide(await stdinLines(), {
        mode: a.mode,
        channel: a.channel,
        bump: a.bump ?? "",
        manual: truthy(a.manual),
        proposed: a.proposed ?? "",
        fromFiles: a["from-files"] ?? "",
        allowMajor: truthy(a["allow-major"]),
        // The prefix after --, so one starting with - is never a flag.
        prefix: prefixArg(a),
      });
      return `ok ${d.version} ${d.current} ${d.reason}`;
    }
    case "tags-path": {
      // tags-path --repo <owner/repo> -- <prefix>: the API path that lists
      // the tags decide needs. The default prefix (and "") needs every
      // tag; any other prefix only its own, each /-separated segment
      // URL-encoded and the slashes kept.
      const repo = a.repo ?? "";
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        throw new UsageError(
          `--repo ${JSON.stringify(repo)} is not owner/repo.`,
        );
      }
      if (a._.length !== 2)
        throw new UsageError("tags-path needs -- <prefix>.");
      const prefix = prefixArg(a);
      const base = `repos/${repo}/git/matching-refs/tags`;
      if (prefix === DEFAULT_PREFIX || prefix === "") return base;
      return `${base}/${prefix.split("/").map(encodeURIComponent).join("/")}`;
    }
    case "strict": {
      // Prints the version rebuilt from its parts; a caller compares it with
      // what it passed, so only a real answer counts.
      const v = parseStrict(a.version);
      return `${v.major}.${v.minor}.${v.patch}`;
    }
    case "current": {
      // The prefix after --, like decide and tags-path.
      const c = currentVersion(await stdinLines(), {
        prefix: prefixArg(a),
        fromFiles: a["from-files"] ?? "",
      });
      if (c.kind === "untagged")
        return c.written ? `untagged ${c.written}` : "untagged";
      return c.version ? `${c.kind} ${c.version}` : c.kind;
    }
    default:
      throw new UsageError(
        "Usage: next-version.mjs decide|next|check|current|strict|tags-path ...",
      );
  }
}

/**
 * Whether the module at `metaUrl` is the script node was started with (not
 * imported). realpath, because import.meta.url is resolved through symlinks
 * (macOS's /var -> /private/var) and argv is not. When it cannot tell, it
 * says yes: a silent no-op would look like an answer. Shared with
 * read-version.mjs.
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return true;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => console.log(out),
    (err) => {
      // Exit 2: the policy says no ("policy: <reason>"). Exit 1: a bad
      // call or a crash. Callers treat anything but 0 and 2 as a hard error.
      const policy = err instanceof PolicyError;
      const msg = policy
        ? `policy: ${err.message}`
        : err instanceof UsageError
          ? err.message
          : err.stack;
      console.error(process.env.GITHUB_ACTIONS ? `::error::${msg}` : msg);
      process.exit(policy ? 2 : 1);
    },
  );
}
