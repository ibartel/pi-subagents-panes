/**
 * herdr surface adapter.
 *
 * herdr (https://herdr.dev) is a terminal workspace manager for AI agents. Its
 * CLI emits JSON for every inspect/create command when stdout is not a TTY,
 * which is always the case here because we capture output.
 *
 * Mapping:
 *   tab        -> `herdr tab create --label <name> --no-focus` (returns root_pane.pane_id)
 *   splitRight -> `herdr pane split <from> --direction right --no-focus`
 *   splitDown  -> `herdr pane split <from> --direction down --no-focus`
 *
 * Splits target the calling pi's pane (`$HERDR_PANE_ID`), so a nested subagent
 * splits its own pane, not the orchestrator's.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { SurfaceAdapter, SurfaceCreateOptions } from "./types.ts";
import { hasCommand } from "./probe.ts";

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 20_000;

export function isHerdrAvailable(): boolean {
  return !!process.env.HERDR_PANE_ID && hasCommand("herdr");
}

function herdr(args: string[]): string {
  return execFileSync("herdr", args, {
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
  });
}

async function herdrAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, {
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
  });
  return stdout;
}

function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, any>) : null;
}

/**
 * Extract the new pane id from a herdr response. Handles `pane_info` (split),
 * `tab_created` (tab), and falls back to a text scan so a future output-shape
 * change does not break spawning outright.
 */
export function extractHerdrPaneId(raw: string): string {
  const parsed = asRecord(parseJson(raw));
  const result = asRecord(parsed?.result);
  const candidates = [
    result?.pane?.pane_id,
    result?.root_pane?.pane_id,
    result?.move_result?.pane?.pane_id,
    result?.focused_pane_id,
    result?.pane_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }

  // Text fallback: herdr pane ids look like `w1:p3`.
  const match = raw.match(/\bw\d+:p\d+\b/);
  if (match) return match[0];
  if (/^\s*\S+\s*$/.test(raw) && raw.trim().startsWith("w")) return raw.trim();

  throw new Error(`Could not determine the new herdr pane id from output: ${raw.trim() || "<empty>"}`);
}

export function extractHerdrScreen(raw: string): string {
  const parsed = asRecord(parseJson(raw));
  const result = asRecord(parsed?.result);
  if (typeof result?.text === "string") return result.text;
  if (Array.isArray(result?.lines)) return result.lines.join("\n");
  // Non-JSON output (TTY or future format) is already the screen.
  return raw;
}

export const herdrAdapter: SurfaceAdapter = {
  mux: "herdr",

  available: isHerdrAvailable,

  setupHint: () =>
    "Start pi inside herdr (`herdr`, then run pi in a pane). herdr must be on PATH.",

  create({ name, mode, fromSurface }: SurfaceCreateOptions): string {
    if (mode === "tab") {
      const args = ["tab", "create", "--label", name, "--no-focus"];
      const workspace = process.env.HERDR_WORKSPACE_ID;
      if (workspace) args.push("--workspace", workspace);
      return extractHerdrPaneId(herdr(args));
    }

    const from = fromSurface ?? process.env.HERDR_PANE_ID;
    if (!from) {
      throw new Error("HERDR_PANE_ID is not set; cannot resolve the pane to split.");
    }
    const direction = mode === "splitRight" ? "right" : "down";
    return extractHerdrPaneId(
      herdr(["pane", "split", from, "--direction", direction, "--no-focus"]),
    );
  },

  send(id: string, command: string): void {
    herdr(["pane", "send-text", id, command]);
    herdr(["pane", "send-keys", id, "Enter"]);
  },

  read(id: string, lines: number): string {
    return extractHerdrScreen(
      herdr(["pane", "read", id, "--source", "visible", "--lines", String(Math.max(1, lines))]),
    );
  },

  async readAsync(id: string, lines: number): Promise<string> {
    return extractHerdrScreen(
      await herdrAsync([
        "pane",
        "read",
        id,
        "--source",
        "visible",
        "--lines",
        String(Math.max(1, lines)),
      ]),
    );
  },

  close(id: string): void {
    herdr(["pane", "close", id]);
  },
};
