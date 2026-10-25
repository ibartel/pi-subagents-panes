/**
 * Orca surface adapter.
 *
 * Orca is the ADE from Stably (https://orca.dev). Its CLI exposes terminal
 * tabs, splits, input, screen reads, and close, which is everything the
 * subagent lifecycle needs. Terminals are addressed by runtime-issued handles
 * (`term_…`), which Orca also injects into each terminal it spawns as
 * `$ORCA_TERMINAL_HANDLE` — so a nested subagent addresses its own pane.
 *
 * Mapping:
 *   tab        -> `orca terminal create --title <name>`
 *   splitRight -> `orca terminal split --direction horizontal` (left/right)
 *   splitDown  -> `orca terminal split --direction vertical` (top/bottom)
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { SurfaceAdapter, SurfaceCreateOptions } from "./types.ts";
import { hasCommand } from "./probe.ts";

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 30_000;

export function isOrcaAvailable(): boolean {
  return (!!process.env.ORCA_TERMINAL_HANDLE || !!process.env.ORCA_PANE_KEY) && hasCommand("orca");
}

function orca(args: string[]): string {
  return execFileSync("orca", args, {
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
  });
}

async function orcaAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("orca", args, {
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
  });
  return stdout;
}

/** Return the `error.message` of an `{ok:false}` Orca payload, if present. */
function orcaError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, any>;
    if (parsed?.ok === false) {
      return String(parsed?.error?.message ?? "Orca command failed");
    }
  } catch {
    // Not JSON — treat as normal output.
  }
  return null;
}

function parseJson(raw: string): Record<string, any> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch {
    return null;
  }
}

/**
 * Find the terminal handle in an Orca response. The exact nesting has changed
 * before (`handle`, `result.handle`, `result.terminal.handle`), so scan the
 * payload for the first `term_…` string instead of hard-coding one path.
 */
export function extractOrcaHandle(raw: string): string {
  const error = orcaError(raw);
  if (error) throw new Error(`Orca: ${error}`);

  const seen = new Set<unknown>();
  const walk = (value: unknown): string | null => {
    if (typeof value === "string") {
      return /^term_[A-Za-z0-9_-]+$/.test(value) ? value : null;
    }
    if (value === null || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };

  const parsed = parseJson(raw);
  const handle = parsed ? walk(parsed) : null;
  if (handle) return handle;

  const textMatch = raw.match(/\bterm_[A-Za-z0-9_-]+\b/);
  if (textMatch) return textMatch[0];

  throw new Error(`Could not determine the new Orca terminal handle from output: ${raw.trim() || "<empty>"}`);
}

/** Extract rendered screen text from an Orca `terminal read --screen` payload. */
export function extractOrcaScreen(raw: string): string {
  const parsed = parseJson(raw);
  const terminal = parsed?.result?.terminal;
  if (Array.isArray(terminal?.tail)) return terminal.tail.join("\n");
  if (typeof terminal?.text === "string") return terminal.text;
  if (typeof parsed?.result?.text === "string") return parsed.result.text;
  return raw;
}

export const orcaAdapter: SurfaceAdapter = {
  mux: "orca",

  available: isOrcaAvailable,

  setupHint: () =>
    "Run pi inside an Orca terminal, with the `orca` CLI on PATH and the Orca app running.",

  create({ name, mode, fromSurface }: SurfaceCreateOptions): string {
    if (mode === "tab") {
      const args = ["terminal", "create", "--title", name, "--json"];
      const worktree = process.env.ORCA_WORKTREE_ID;
      if (worktree) args.push("--worktree", worktree);
      return extractOrcaHandle(orca(args));
    }

    const from = fromSurface ?? process.env.ORCA_TERMINAL_HANDLE;
    if (!from) {
      throw new Error(
        "ORCA_TERMINAL_HANDLE is not set; cannot resolve the terminal to split.",
      );
    }
    const direction = mode === "splitRight" ? "horizontal" : "vertical";
    return extractOrcaHandle(
      orca(["terminal", "split", "--terminal", from, "--direction", direction, "--json"]),
    );
  },

  send(id: string, command: string): void {
    const raw = orca([
      "terminal",
      "send",
      "--terminal",
      id,
      "--text",
      command,
      "--enter",
      "--json",
    ]);
    const error = orcaError(raw);
    if (error) throw new Error(`Orca: ${error}`);
  },

  read(id: string, lines: number): string {
    return extractOrcaScreen(
      orca([
        "terminal",
        "read",
        "--terminal",
        id,
        "--screen",
        "--limit",
        String(Math.max(1, lines)),
        "--json",
      ]),
    );
  },

  async readAsync(id: string, lines: number): Promise<string> {
    return extractOrcaScreen(
      await orcaAsync([
        "terminal",
        "read",
        "--terminal",
        id,
        "--screen",
        "--limit",
        String(Math.max(1, lines)),
        "--json",
      ]),
    );
  },

  close(id: string): void {
    const raw = orca(["terminal", "close", "--terminal", id, "--json"]);
    const error = orcaError(raw);
    if (error) throw new Error(`Orca: ${error}`);
  },
};
