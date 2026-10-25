/**
 * Safe bash extension for the worker subagent.
 * Wraps the built-in bash tool with a best-effort denylist of destructive
 * command forms.
 *
 * This is NOT a security boundary and NOT a sandbox. It blocks only common
 * destructive/accidental forms (a `rm -rf /` typo, a stray `sudo`, a
 * `curl | sh`, a write into `~/.ssh`, ...). A denylist cannot contain a real
 * general-purpose shell: agents such as worker/debugger/tester need one, and
 * anything that can run `node -e`, `python3 -c` or a script can trivially
 * reconstruct a blocked command. We intentionally do NOT block interpreters
 * (`node -e`, `python3 -c`, `perl -e`) because they are core to the work.
 *
 * Therefore: never rely on this module to sandbox untrusted input. Untrusted
 * input (e.g. text fetched from the internet) must not reach a shell at all —
 * see the `researcher` agent, which has no shell precisely because of prompt
 * injection.
 *
 * Deliberately NOT blocked (all trivially able to run arbitrary code, which is
 * the point): `node -e`, `python3 -c`, `perl -e`, piping a download into an
 * interpreter (`curl ... | python3`), running a local script
 * (`bash script.sh`), `xargs rm`, `find -delete`, `curl -o f && ./f`. Because
 * quotes are stripped before matching, destructive text inside an interpreter
 * string can produce a false positive; that is accepted in exchange for
 * catching `r''m -rf /`.
 *
 * Loaded into a child pi process via `--extension` when an agent's `tools`
 * frontmatter lists `safe_bash`. See CUSTOM_TOOL_EXTENSIONS in ../index.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Paths that hold credentials or executable git hooks. A write (or a
 * copy/move/tee/sed -i) into one of these is treated as dangerous.
 * Matches `~/.ssh`, `$HOME/.aws`, `${HOME}/.config`, `/.netrc`,
 * `/.gitconfig`, anything under `/etc/`, and `.git/hooks`.
 */
const CREDENTIAL_TARGET = String.raw`(?:~|\$HOME|\$\{HOME\})?\/?(?:\.ssh|\.aws|\.config|\.netrc|\.gitconfig)\b|\/etc\/|\.git\/hooks\b`;

const SHELLS = "sh|bash|zsh|dash|ksh";

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	// rm against absolute or home paths (the classic "delete the world" forms).
	{
		pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
		reason: "rm of an absolute or home path",
	},
	{
		pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
		reason: "rm of an absolute or home path",
	},
	{ pattern: /\bsudo\b/, reason: "sudo" },
	{ pattern: /\bmkfs\b/, reason: "mkfs" },
	{ pattern: /\bdd\s+if=/, reason: "dd if=" },
	{ pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: "fork bomb" },
	{ pattern: />\s*\/dev\/[sh]d[a-z]/, reason: "raw write to a block device" },
	{
		pattern: /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
		reason: "chmod 777 on /",
	},
	{ pattern: /\bchown\s+(-[a-zA-Z]+\s+)?root/, reason: "chown root" },
	// Download piped straight into a shell interpreter.
	{
		pattern: new RegExp(`\\b(?:curl|wget)\\b[^|]*\\|\\s*(?:sudo\\s+)?(?:${SHELLS})\\b`),
		reason: "download piped into a shell",
	},
	// Download then execute via a chain: `curl -o f; sh f`, `wget x && bash x`.
	{
		pattern: new RegExp(`\\b(?:curl|wget)\\b[^;&|]*[;&]+[^;&|]*\\b(?:${SHELLS})\\b`),
		reason: "download followed by shell execution",
	},
	// A bare shell command after a chain/separator: `; sh`, `&& bash`.
	{
		pattern: new RegExp(`[;&|]\\s*(?:sudo\\s+)?(?:${SHELLS})\b`),
		reason: "shell interpreter launched in a command chain",
	},
	// Process substitution fed to a shell: `bash <(curl ...)`.
	{
		pattern: new RegExp(`\\b(?:${SHELLS})\\b[^;&|]*<\\(`),
		reason: "shell interpreter fed by process substitution",
	},
	// Sourcing a shell script file (`source ./x.sh`, `. ./x.sh`).
	{
		pattern: new RegExp(`\\bsource\\s+[^;&|]*\\.(?:${SHELLS})\\b`),
		reason: "source of a shell script",
	},
	{
		pattern: new RegExp(`(?:^|[;&|]\\s*)\\.\\s+[^;&|]*\\.(?:${SHELLS})\\b`),
		reason: "dot-sourcing of a shell script",
	},
	// eval of command substitution or a pipeline.
	{ pattern: /\beval\s+[^;&|]*\$\(/, reason: "eval of command substitution" },
	{ pattern: /\beval\s+[^;&|]*`/, reason: "eval of command substitution" },
	{ pattern: /\beval\s+[^;&|]*\|/, reason: "eval of a pipeline" },
	// Writes into credential locations / git hooks.
	{
		pattern: new RegExp(
			`(?:>>?|\\btee\\b|\\bcp\\b|\\bmv\\b|\\binstall\\b|\\bsed\\s+-i\\b)[^;&|]*[\\s'"]?(?:${CREDENTIAL_TARGET})`,
		),
		reason: "write into a credential or git-hook location",
	},
	{
		pattern: /\bchmod\b[^;&|]*\.git\/hooks\//,
		reason: "write into a git-hook location",
	},
	// Host control.
	{ pattern: /\bshutdown\b/, reason: "shutdown" },
	{ pattern: /\breboot\b/, reason: "reboot" },
	{ pattern: /\binit\s+0\b/, reason: "init 0" },
	{ pattern: /\bkill\s+-9\s+1\b/, reason: "kill -9 1" },
	{ pattern: /\bkillall\b/, reason: "killall" },
];

/**
 * Normalization is intentionally lossy: it strips line continuations, removes
 * quote characters and collapses whitespace so that `r''m  -rf "/"` is
 * inspected as `rm -rf /`. It is not a parser and does not try to be.
 */
function normalize(command: string): string {
	return command
		.replace(/\\\n/g, " ")
		.replace(/['"]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Targets that make a recursive `rm` catastrophic rather than routine. */
const DANGEROUS_RM_TARGETS = new Set([
	"",
	".",
	"..",
	"*",
	"./*",
	"../*",
	"~",
	"~/*",
	"$HOME",
	"${HOME}",
	"$HOME/*",
	"${HOME}/*",
	"/",
	"/*",
]);

/**
 * Token-level check for recursive `rm`. Catches `rm -rf`, `rm -rf .`,
 * `rm -rf *`, `rm -rf ./`, `rm -r ..`, `rm -rf "$HOME"` — none of which the
 * regex patterns above see, because they require `/` or `~` after the flags.
 */
function checkRecursiveRm(normalized: string): string | null {
	for (const segment of normalized.split(/[;&|]+/)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		for (let i = 0; i < tokens.length; i++) {
			if (!/(?:^|\/)rm$/.test(tokens[i])) continue;

			let recursive = false;
			const targets: string[] = [];
			for (const arg of tokens.slice(i + 1)) {
				if (arg.startsWith("--")) {
					if (arg === "--recursive") recursive = true;
				} else if (arg.startsWith("-") && arg.length > 1) {
					if (/[rR]/.test(arg)) recursive = true;
				} else {
					targets.push(arg);
				}
			}
			if (!recursive) continue;

			if (targets.length === 0) {
				return "Command blocked by safe_bash: recursive rm with no target";
			}
			for (const target of targets) {
				const trimmed = target.replace(/\/+$/, "") || "/";
				if (
					DANGEROUS_RM_TARGETS.has(target) ||
					DANGEROUS_RM_TARGETS.has(trimmed) ||
					target.startsWith("/") ||
					target.startsWith("~") ||
					target.startsWith("$HOME") ||
					target.startsWith("${HOME}")
				) {
					return `Command blocked by safe_bash: recursive rm of ${target}`;
				}
			}
		}
	}
	return null;
}

/**
 * Returns a human-readable reason when `command` matches a known destructive
 * form, or `null` when it looks ordinary. Best effort only — see the module
 * comment: a `null` result does not mean the command is safe.
 */
export function isDangerous(command: string): string | null {
	const normalized = normalize(command);

	for (const { pattern, reason } of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: ${reason} (pattern ${pattern})`;
		}
	}

	return checkRecursiveRm(normalized);
}

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());

	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. Blocks only common destructive or accidental command forms " +
			"(rm -rf on /, ~, the cwd or a wildcard; sudo; mkfs; dd if=; piped/chained shell " +
			"execution; writes into ~/.ssh, ~/.aws, ~/.config, /etc or .git/hooks; fork bombs; " +
			"shutdown/reboot; killall). This is NOT a sandbox and NOT a security boundary: it cannot " +
			"contain hostile input (interpreters like `node -e` and `python3 -c` are allowed on " +
			"purpose). Never let untrusted/hostile input reach this tool; agents that read untrusted " +
			"content must not have a shell at all.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) {
				throw new Error(danger);
			}
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
