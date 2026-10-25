/**
 * Read-only bash for the `architect` planner.
 *
 * The planner must inspect a repository without changing it. The built-in
 * `bash` tool cannot express that, so this tool wraps it with a strict
 * command validator: inspection commands only, no mutation, no redirection,
 * no command substitution, no chaining beyond pipes whose every segment is
 * itself read-only.
 *
 * The validator is an allowlist: a command must be a bare PATH name (never a
 * path to an executable), and every flag it receives must be listed here.
 * A blocklist of "dangerous" flags is not enough: many tools accept attached
 * or abbreviated forms (`-ofoo`, `-i.bak`, `--out=`, `-fls`) that a token
 * equality check misses.
 *
 * Loaded into a child pi process via `-e` when an agent's `tools` frontmatter
 * lists `read_only_bash`. See the tool→extension map in ../index.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Commands that cannot write, each with the exact flags it may be given.
 *
 * Deliberately small: `node`, `awk`, `perl`, `tee`, `xargs`, `sed`, `rg`, `jq`,
 * `tree`, and `file` are excluded because each can run code/write files or is
 * redundant with `read`/`grep`/`find`. Unknown flags are rejected rather than
 * ignored, so attached forms like `sort -ofoo` cannot slip through.
 */
const ALLOWED_FLAGS: Record<string, Set<string>> = {
  basename: new Set(["-a", "-s", "-z", "--multiple", "--suffix", "--zero"]),
  cat: new Set(["-A", "-b", "-e", "-E", "-n", "-s", "-T", "-v", "--number", "--show-all"]),
  comm: new Set([
    "-1",
    "-12",
    "-123",
    "-13",
    "-2",
    "-23",
    "-3",
    "--check-order",
    "--nocheck-order",
    "--output-delimiter",
    "--total",
  ]),
  cut: new Set(["-b", "-c", "-d", "-f", "-s", "-z", "--complement", "--output-delimiter", "--zero-terminated"]),
  diff: new Set([
    "-a",
    "-B",
    "-b",
    "-c",
    "-i",
    "-N",
    "-q",
    "-r",
    "-u",
    "-w",
    "-y",
    "--brief",
    "--color",
    "--expand-tabs",
    "--ignore-all-space",
    "--ignore-blank-lines",
    "--ignore-case",
    "--ignore-space-change",
    "--ignore-trailing-space",
    "--label",
    "--minimal",
    "--no-dereference",
    "--recursive",
    "--speed-large-files",
    "--text",
    "--unidirectional-new-file",
    "--unified",
  ]),
  dirname: new Set(["-z", "--zero"]),
  du: new Set([
    "-0",
    "-a",
    "-b",
    "-c",
    "-d",
    "-h",
    "-k",
    "-L",
    "-m",
    "-s",
    "-sh",
    "-x",
    "--all",
    "--apparent-size",
    "--bytes",
    "--human-readable",
    "--inodes",
    "--max-depth",
    "--summarize",
    "--total",
  ]),
  echo: new Set(["-e", "-E", "-n"]),
  find: new Set([
    "-a",
    "-Bmin",
    "-Bnewer",
    "-Btime",
    "-cmin",
    "-cnewer",
    "-ctime",
    "-d",
    "-daystart",
    "-delete-empty",
    "-depth",
    "-empty",
    "-executable",
    "-false",
    "-follow",
    "-group",
    "-ilname",
    "-iname",
    "-inum",
    "-ipath",
    "-iregex",
    "-iwholename",
    "-links",
    "-lname",
    "-ls",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mount",
    "-mtime",
    "-name",
    "-newer",
    "-newerXY",
    "-noleaf",
    "-not",
    "-nouser",
    "-o",
    "-path",
    "-perm",
    "-print",
    "-print0",
    "-printf",
    "-prune",
    "-quit",
    "-readable",
    "-regex",
    "-samefile",
    "-size",
    "-true",
    "-type",
    "-uid",
    "-used",
    "-user",
    "-wholename",
    "-writable",
    "-xdev",
    "-xtype",
    "-L",
    "-P",
    "-H",
  ]),
  grep: new Set([
    "-A",
    "-B",
    "-C",
    "-E",
    "-F",
    "-G",
    "-H",
    "-I",
    "-P",
    "-R",
    "-a",
    "-b",
    "-c",
    "-e",
    "-h",
    "-i",
    "-in",
    "-l",
    "-m",
    "-n",
    "-o",
    "-q",
    "-r",
    "-ri",
    "-rl",
    "-rn",
    "-rni",
    "-ro",
    "-s",
    "-v",
    "-w",
    "-x",
    "-z",
    "--after-context",
    "--before-context",
    "--binary-files",
    "--color",
    "--context",
    "--count",
    "--directories",
    "--exclude",
    "--exclude-dir",
    "--extended-regexp",
    "--files-with-matches",
    "--files-without-match",
    "--fixed-strings",
    "--ignore-case",
    "--include",
    "--invert-match",
    "--line-number",
    "--line-regexp",
    "--max-count",
    "--no-color",
    "--no-filename",
    "--no-messages",
    "--only-matching",
    "--perl-regexp",
    "--quiet",
    "--recursive",
    "--regexp",
    "--silent",
    "--text",
    "--with-filename",
    "--word-regexp",
  ]),
  head: new Set(["-c", "-n", "-q", "-v", "-z", "--bytes", "--lines", "--quiet", "--silent", "--verbose", "--zero-terminated"]),
  ls: new Set([
    "-1",
    "-A",
    "-a",
    "-al",
    "-alh",
    "-d",
    "-F",
    "-G",
    "-h",
    "-i",
    "-l",
    "-la",
    "-lah",
    "-lh",
    "-lha",
    "-n",
    "-p",
    "-r",
    "-R",
    "-S",
    "-t",
    "-U",
    "-X",
    "--all",
    "--almost-all",
    "--color",
    "--directory",
    "--human-readable",
    "--inode",
    "--long",
    "--no-color",
    "--recursive",
    "--reverse",
    "--size",
    "--time",
  ]),
  md5sum: new Set([
    "-b",
    "-c",
    "-t",
    "--binary",
    "--check",
    "--ignore-missing",
    "--quiet",
    "--status",
    "--strict",
    "--text",
    "--warn",
  ]),
  nl: new Set(["-a", "-b", "-ba", "-d", "-f", "-h", "-i", "-l", "-n", "-p", "-s", "-v", "-w"]),
  pwd: new Set(["-L", "-P", "--logical", "--physical"]),
  realpath: new Set([
    "-e",
    "-m",
    "-q",
    "-s",
    "-z",
    "--canonicalize-existing",
    "--logical",
    "--no-symlinks",
    "--physical",
    "--quiet",
    "--relative-base",
    "--relative-to",
    "--strip",
    "--zero",
  ]),
  sha256sum: new Set([
    "-b",
    "-c",
    "-t",
    "--binary",
    "--check",
    "--ignore-missing",
    "--quiet",
    "--status",
    "--strict",
    "--text",
    "--warn",
  ]),
  sort: new Set([
    "-b",
    "-c",
    "-d",
    "-f",
    "-g",
    "-h",
    "-i",
    "-k",
    "-M",
    "-n",
    "-r",
    "-R",
    "-s",
    "-S",
    "-t",
    "-u",
    "-V",
    "-z",
    "--batch-size",
    "--buffer-size",
    "--check",
    "--dictionary-order",
    "--field-separator",
    "--general-numeric-sort",
    "--human-numeric-sort",
    "--ignore-case",
    "--key",
    "--month-sort",
    "--numeric-sort",
    "--random-sort",
    "--reverse",
    "--sort",
    "--stable",
    "--temporary-directory",
    "--unique",
    "--version-sort",
    "--zero-terminated",
  ]),
  stat: new Set(["-c", "-f", "-L", "-t", "--dereference", "--file-system", "--format", "--printf", "--terse"]),
  tail: new Set([
    "-c",
    "-f",
    "-F",
    "-n",
    "-q",
    "-s",
    "-v",
    "-z",
    "--bytes",
    "--follow",
    "--lines",
    "--quiet",
    "--retry",
    "--silent",
    "--sleep-interval",
    "--verbose",
    "--zero-terminated",
  ]),
  tr: new Set(["-c", "-C", "-d", "-s", "-t", "--complement", "--delete", "--squeeze-repeats", "--truncate-set1"]),
  uniq: new Set([
    "-c",
    "-d",
    "-D",
    "-f",
    "-i",
    "-s",
    "-u",
    "-w",
    "-z",
    "--all-repeated",
    "--count",
    "--group",
    "--ignore-case",
    "--repeated",
    "--skip-chars",
    "--skip-fields",
    "--unique",
    "--zero-terminated",
  ]),
  wc: new Set([
    "-c",
    "-l",
    "-L",
    "-m",
    "-w",
    "--bytes",
    "--chars",
    "--lines",
    "--max-line-length",
    "--words",
  ]),
  which: new Set(["-a", "-s", "-v", "--all", "--skip-dot", "--skip-tilde", "--show-dot", "--show-tilde"]),
};

/**
 * Short flags that accept an attached value (`cut -d:`, `sort -k2`, `grep -A3`).
 * The prefix is checked after the command's specific write checks, so e.g.
 * `sort -ofoo` is still rejected as a write.
 */
const ATTACHED_SHORT_ARG_PREFIXES: Record<string, string[]> = {
  cut: ["-b", "-c", "-d", "-f"],
  du: ["-d"],
  grep: ["-A", "-B", "-C", "-m"],
  head: ["-c", "-n"],
  nl: ["-i", "-l", "-s", "-v", "-w"],
  sort: ["-k", "-S", "-t"],
  stat: ["-c", "-f"],
  tail: ["-c", "-n", "-s"],
  uniq: ["-f", "-s", "-w"],
};

/** `git` subcommands that never change the working tree or index. */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "blame",
  "branch",
  "cat-file",
  "describe",
  "diff",
  "log",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "shortlog",
  "show",
  "status",
  "tag",
]);

/** `git branch`/`git tag` only list when given these flags. */
const GIT_LISTING_FLAGS = new Set([
  "--abbrev",
  "--all",
  "--color",
  "--column",
  "--contains",
  "--format",
  "--ignore-case",
  "--list",
  "--merged",
  "--no-abbrev",
  "--no-color",
  "--no-column",
  "--no-contains",
  "--no-merged",
  "--points-at",
  "--remotes",
  "--show-current",
  "--sort",
  "--verbose",
  "-a",
  "-i",
  "-l",
  "-r",
  "-v",
  "-vv",
]);

/**
 * Flags that explicitly take a positional filter argument (`--contains HEAD`),
 * so a positional token after one of them is a filter, not a ref mutation.
 */
const GIT_LISTING_WITH_POSITIONAL = new Set([
  "--contains",
  "--list",
  "--merged",
  "--no-contains",
  "--no-merged",
  "--points-at",
  "--sort",
  "-l",
]);

/** Per-subcommand flags for the remaining read-only git subcommands. */
const GIT_ALLOWED_FLAGS: Record<string, Set<string>> = {
  blame: new Set([
    "-C",
    "-L",
    "-M",
    "-e",
    "-p",
    "-s",
    "-w",
    "--abbrev",
    "--date",
    "--ignore-rev",
    "--ignore-revs-file",
    "--line-porcelain",
    "--porcelain",
    "--reverse",
    "--root",
    "--show-email",
    "--show-name",
    "--show-number",
  ]),
  "cat-file": new Set(["-e", "-p", "-s", "-t", "--batch", "--batch-all-objects", "--batch-check"]),
  describe: new Set([
    "--abbrev",
    "--all",
    "--always",
    "--contains",
    "--dirty",
    "--exact-match",
    "--exclude",
    "--first-parent",
    "--long",
    "--match",
    "--tags",
  ]),
  diff: new Set([
    "-C",
    "-M",
    "-p",
    "-U",
    "-u",
    "--binary",
    "--cached",
    "--check",
    "--color",
    "--compact-summary",
    "--diff-filter",
    "--dirstat",
    "--dst-prefix",
    "--exit-code",
    "--find-renames",
    "--ignore-all-space",
    "--ignore-blank-lines",
    "--ignore-case",
    "--ignore-space-change",
    "--ignore-space-at-eol",
    "--name-only",
    "--name-status",
    "--no-color",
    "--no-index",
    "--no-renames",
    "--numstat",
    "--patch",
    "--quiet",
    "--raw",
    "--relative",
    "--shortstat",
    "--src-prefix",
    "--stat",
    "--stat-count",
    "--stat-name-width",
    "--stat-width",
    "--staged",
    "--summary",
    "--unified",
    "--word-diff",
  ]),
  log: new Set([
    "-g",
    "-n",
    "-p",
    "--abbrev-commit",
    "--all",
    "--author",
    "--binary",
    "--color",
    "--date",
    "--date-order",
    "--decorate",
    "--first-parent",
    "--follow",
    "--format",
    "--full-history",
    "--graph",
    "--grep",
    "--left-right",
    "--max-count",
    "--merges",
    "--name-only",
    "--name-status",
    "--no-color",
    "--no-decorate",
    "--no-merges",
    "--no-patch",
    "--numstat",
    "--oneline",
    "--patch",
    "--pretty",
    "--raw",
    "--relative-date",
    "--reverse",
    "--shortstat",
    "--simplify-merges",
    "--since",
    "--skip",
    "--stat",
    "--summary",
    "--topo-order",
    "--until",
  ]),
  "ls-files": new Set([
    "-c",
    "-d",
    "-i",
    "-m",
    "-o",
    "-s",
    "-u",
    "-x",
    "-z",
    "--cached",
    "--deleted",
    "--deduplicate",
    "--directory",
    "--error-unmatch",
    "--exclude",
    "--exclude-standard",
    "--full-name",
    "--ignored",
    "--modified",
    "--others",
    "--recurse-submodules",
    "--stage",
    "--unmerged",
  ]),
  "ls-tree": new Set([
    "-d",
    "-l",
    "-r",
    "-t",
    "-z",
    "--abbrev",
    "--full-name",
    "--full-tree",
    "--long",
    "--name-only",
    "--name-status",
    "--object-only",
  ]),
  "rev-parse": new Set([
    "--abbrev-ref",
    "--absolute-git-dir",
    "--all",
    "--branches",
    "--default",
    "--git-dir",
    "--is-bare-repository",
    "--is-inside-git-dir",
    "--is-inside-work-tree",
    "--is-shallow-repository",
    "--local-env-vars",
    "--not",
    "--path-format",
    "--remotes",
    "--resolve-git-dir",
    "--short",
    "--show-cdup",
    "--show-prefix",
    "--show-superproject-working-tree",
    "--show-toplevel",
    "--sq-quote",
    "--symbolic",
    "--symbolic-full-name",
    "--tags",
    "--verify",
  ]),
  shortlog: new Set([
    "-e",
    "-n",
    "-s",
    "--author",
    "--email",
    "--format",
    "--group",
    "--numbered",
    "--since",
    "--summary",
    "--until",
  ]),
  show: new Set([
    "-p",
    "-s",
    "--abbrev-commit",
    "--color",
    "--date",
    "--decorate",
    "--format",
    "--name-only",
    "--name-status",
    "--no-color",
    "--no-decorate",
    "--no-patch",
    "--numstat",
    "--oneline",
    "--patch",
    "--pretty",
    "--raw",
    "--shortstat",
    "--stat",
    "--summary",
  ]),
  status: new Set([
    "-b",
    "-s",
    "-sb",
    "-bs",
    "-u",
    "-v",
    "-z",
    "--ahead-behind",
    "--branch",
    "--column",
    "--find-renames",
    "--ignored",
    "--long",
    "--no-ahead-behind",
    "--no-column",
    "--no-renames",
    "--null",
    "--porcelain",
    "--renames",
    "--short",
    "--show-stash",
    "--untracked-files",
    "--verbose",
  ]),
};

/** Attached-value short forms for git flags (`git log -n20`, `git diff -U5`). */
const GIT_ATTACHED_FLAGS: Record<string, string[]> = {
  blame: ["-C", "-L", "-M"],
  diff: ["-C", "-M", "-U"],
  log: ["-n"],
  show: ["-n"],
};

/** Predicates whose prefix means `find` can execute a program or write a file. */
const FIND_WRITE_PREDICATE = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)/;

const PROC_ENVIRON = /(?:^|\/)proc\/(?:self|thread-self|[0-9]+)\/environ/;

const SHELL_METACHARACTERS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /[`$]/, reason: "command substitution and variables are not allowed" },
  { pattern: /[<>]/, reason: "redirection is not allowed (the planner must not write files)" },
  { pattern: /[;&\n]/, reason: "command chaining is not allowed; run one command per call" },
];

function firstToken(segment: string): string {
  const match = segment.trim().match(/^\S+/);
  return match ? match[0] : "";
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-" && token !== "--";
}

/** The part of a flag before `=`, so `--exclude=*.ts` checks as `--exclude`. */
function flagName(token: string): string {
  return token.split("=")[0] ?? token;
}

function checkFlags(command: string, tokens: string[]): string | null {
  const allowed = ALLOWED_FLAGS[command];
  if (!allowed) return `"${command}" is not an allowed inspection command`;

  const attached = ATTACHED_SHORT_ARG_PREFIXES[command] ?? [];
  const numericFlags = command === "head" || command === "tail";

  for (const token of tokens.slice(1)) {
    if (!isFlag(token)) continue;
    // `head -20` / `tail -20` are the historical short forms of `-n 20`.
    if (numericFlags && /^-\d+$/.test(token)) continue;
    if (allowed.has(token) || allowed.has(flagName(token))) continue;
    if (attached.some((prefix) => token.startsWith(prefix) && token.length > prefix.length)) continue;
    return `unknown flag "${token}" for ${command}; only allowlisted inspection flags are permitted`;
  }

  return null;
}

function checkGit(tokens: string[]): string | null {
  // `git -c`/`--config` may point a pager or diff driver at an external program.
  // Check every token, including the ones that precede the subcommand.
  for (const token of tokens.slice(1)) {
    if (!isFlag(token)) continue;
    const name = flagName(token);
    if (name === "-c" || name.startsWith("--config")) {
      return `"git ${name}" can redirect git to an external program`;
    }
  }

  const subcommand = tokens[1] ?? "";
  if (!GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) {
    return `"git ${subcommand}" is not a read-only git subcommand`;
  }

  const args = tokens.slice(2);

  if (["diff", "log", "show"].includes(subcommand)) {
    for (const token of args) {
      if (!isFlag(token)) continue;
      const name = flagName(token);
      // Any `--out*` is an abbreviated `--output` (`git diff --out=foo`).
      if (name.startsWith("--out")) return "git --output writes a file";
      if (name === "--ext-diff" || name === "--textconv" || token.startsWith("-O")) {
        return `"git ${subcommand} ${name}" runs an external program`;
      }
    }
  }

  if (subcommand === "branch" || subcommand === "tag") {
    let filterPositional = false;
    for (const token of args) {
      if (!isFlag(token)) {
        if (!filterPositional) {
          return `"git ${subcommand} ${token}" is not a listing; add --list/-a/-v`;
        }
        continue;
      }
      const name = flagName(token);
      if (!GIT_LISTING_FLAGS.has(name)) {
        return `"git ${subcommand} ${name}" can modify refs; only listing flags are allowed`;
      }
      if (GIT_LISTING_WITH_POSITIONAL.has(name)) filterPositional = true;
    }
    return null;
  }

  const allowed = GIT_ALLOWED_FLAGS[subcommand] ?? new Set<string>();
  const attached = GIT_ATTACHED_FLAGS[subcommand] ?? [];
  for (const token of args) {
    if (!isFlag(token)) continue;
    if (/^-\d+$/.test(token) && ["log", "show", "shortlog", "blame"].includes(subcommand)) continue;
    if (allowed.has(token) || allowed.has(flagName(token))) continue;
    if (attached.some((prefix) => token.startsWith(prefix) && token.length > prefix.length)) continue;
    return `unknown flag "${token}" for "git ${subcommand}"; only allowlisted inspection flags are permitted`;
  }

  return null;
}

function checkSegment(segment: string): string | null {
  const trimmed = segment.trim();
  if (trimmed === "") return null;

  const tokens = trimmed.split(/\s+/);
  const commandToken = firstToken(trimmed);

  // Any path to an executable (`./cat`, `/tmp/git`, `../bin/ls`) would let the
  // caller run a binary of their choosing under a trusted name.
  if (commandToken.includes("/")) {
    return `"${commandToken}" is an executable path; executable paths are not allowed, use the bare command name`;
  }

  const command = commandToken;

  if (command !== "git" && !ALLOWED_FLAGS[command]) {
    return `"${command}" is not an allowed inspection command`;
  }

  if (tokens.some((token) => PROC_ENVIRON.test(token))) {
    return "reading /proc/*/environ would leak environment secrets";
  }

  if (command === "git") return checkGit(tokens);

  if (command === "find") {
    for (const token of tokens.slice(1)) {
      if (FIND_WRITE_PREDICATE.test(token)) {
        return "find with -exec/-delete/-fprint/-fls would modify files";
      }
    }
  }

  if (command === "sort") {
    for (const token of tokens.slice(1)) {
      const name = flagName(token);
      if (name === "-o" || name.startsWith("-o") || name.startsWith("--out")) {
        return "sort -o/--output writes a file";
      }
      if (name.startsWith("--compress-program")) {
        return "sort --compress-program runs an external program";
      }
    }
  }

  if (command === "uniq") {
    // `uniq in out` writes to its second positional argument.
    const positionals = tokens.slice(1).filter((token) => !token.startsWith("-"));
    if (positionals.length > 1) {
      return "uniq with an output file would write";
    }
  }

  return checkFlags(command, tokens);
}

function checkReadOnlyCommandInternal(command: string): string | null {
  if (command.trim() === "") return "empty command";

  for (const { pattern, reason } of SHELL_METACHARACTERS) {
    if (pattern.test(command)) return reason;
  }

  for (const segment of command.split("|")) {
    const problem = checkSegment(segment);
    if (problem) return problem;
  }

  return null;
}

/**
 * Returns the rejection reason for a command that would write, or `null` when
 * the whole command line is safe to run in read-only mode.
 */
export function checkReadOnlyCommand(command: string): string | null {
  return checkReadOnlyCommandInternal(command);
}

export default function (pi: ExtensionAPI) {
  const bashTool = createBashTool(process.cwd());

  pi.registerTool({
    name: "read_only_bash",
    label: "Read-Only Bash",
    description:
      "Run an inspection command (ls, cat, grep, git log, git diff, ...). Blocks anything that can modify the repository: " +
      "redirection, command substitution, chaining, write subcommands, executable paths, and unlisted flags. Use this instead of bash.",
    parameters: Type.Object({
      command: Type.String({ description: "Read-only inspection command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
    }),
    async execute(toolCallId, params: { command: string; timeout?: number }, signal, onUpdate) {
      const problem = checkReadOnlyCommand(params.command);
      if (problem) {
        throw new Error(
          `read_only_bash blocked the command: ${problem}. ` +
            "You are planning, not implementing: inspect with read/grep/find/ls/read_only_bash and name the agent that changes the code.",
        );
      }
      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
