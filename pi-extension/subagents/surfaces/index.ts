/**
 * Public surface API used by the extension.
 *
 * Nothing outside this folder talks to a multiplexer directly: spawn, steer,
 * read, and close all go through the same handful of functions, so adding a
 * backend only means adding an adapter.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { herdrAdapter } from "./herdr.ts";
import { orcaAdapter } from "./orca.ts";
import { tmuxAdapter } from "./tmux.ts";
import {
  decodeHandle,
  encodeHandle,
  MUX_NAMES,
  type DisplayMode,
  type MuxName,
  type SurfaceAdapter,
} from "./types.ts";

export {
  DISPLAY_MODES,
  MUX_NAMES,
  decodeHandle,
  encodeHandle,
  type DisplayMode,
  type MuxName,
  type SurfaceAdapter,
} from "./types.ts";
export { hasCommand } from "./probe.ts";
export { isTmuxAvailable } from "./tmux.ts";
import * as tmuxModule from "./tmux.ts";

const ADAPTERS: Record<MuxName, SurfaceAdapter> = {
  tmux: tmuxAdapter,
  herdr: herdrAdapter,
  orca: orcaAdapter,
};

/**
 * Detection order. A pi session lives in exactly one of these in practice;
 * the order only matters in the odd nested setup (herdr inside tmux, say),
 * where the innermost mux is the one whose env we should trust. orca/herdr
 * export a dedicated pane handle, tmux only sets `TMUX`.
 */
const DETECTION_ORDER: readonly MuxName[] = ["orca", "herdr", "tmux"];

/** User override from `config.json` (`display.multiplexer`). */
let muxPreference: MuxName | null = null;
let cachedDetected: MuxName | null | undefined;

export type MultiplexerPreference = MuxName | "auto";

/** Apply the configured multiplexer preference. `auto` restores detection. */
export function configureSurfaces(multiplexer: MultiplexerPreference | undefined): void {
  if (!multiplexer || multiplexer === "auto") {
    muxPreference = null;
  } else if (MUX_NAMES.includes(multiplexer)) {
    muxPreference = multiplexer;
  } else {
    throw new Error(
      `Unsupported display.multiplexer "${String(multiplexer)}". Use one of: auto, ${MUX_NAMES.join(", ")}.`,
    );
  }
  cachedDetected = undefined;
}

export function detectMux(): MuxName | null {
  if (cachedDetected !== undefined) return cachedDetected;
  cachedDetected = DETECTION_ORDER.find((mux) => ADAPTERS[mux].available()) ?? null;
  return cachedDetected;
}

/** The mux this process will spawn into (preference wins over detection). */
export function activeMux(): MuxName | null {
  return muxPreference ?? detectMux();
}

function requireAdapter(): SurfaceAdapter {
  const mux = activeMux();
  if (!mux) {
    throw new Error(`No supported terminal multiplexer detected. ${muxSetupHint()}`);
  }
  return ADAPTERS[mux];
}

function adapterFor(handle: string): SurfaceAdapter {
  return ADAPTERS[decodeHandle(handle).mux];
}

export function isMuxAvailable(): boolean {
  return activeMux() !== null;
}

export function muxSetupHint(): string {
  const configured = muxPreference ? `Configured multiplexer: ${muxPreference}. ` : "";
  return (
    `${configured}Subagents need one of: Orca (orca CLI + running app), ` +
    `herdr (herdr CLI inside a herdr pane), or tmux. ` +
    `Use --multiplexer in config.json or set display.multiplexer to force one.`
  );
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Render a free-form banner as a run of `#` comment lines.
 *
 * Callers embed caller-supplied values (agent names, paths, surfaces) in these
 * headers. A newline in one of those values would otherwise end the comment and
 * turn the remainder of that value into executable script text, so every line is
 * forced to start with `#` no matter where the line break came from.
 */
export function renderScriptHeader(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => (line.length === 0 ? "#" : line.startsWith("#") ? line : `# ${line}`))
    .join("\n");
}

/** Build the full launch-script payload. Exported so tests can assert on it. */
export function renderScript(command: string, preamble?: string): string {
  const lines = ["#!/bin/bash"];
  const header = preamble?.trimEnd();
  if (header) lines.push(renderScriptHeader(header));
  lines.push(command);
  return lines.join("\n") + "\n";
}

/**
 * Write a launch script with owner-only permissions.
 *
 * The script carries the task text, which may hold secrets, so it must not be
 * readable by other local users (`0o700`, not the old `0o755`). `wx` is
 * `O_CREAT|O_EXCL`, which both refuses to clobber an existing file and refuses
 * to follow a pre-planted symlink at that path.
 */
export function writeScriptFile(scriptPath: string, text: string): void {
  mkdirSync(dirname(scriptPath), { recursive: true, mode: 0o700 });
  writeFileSync(scriptPath, text, { mode: 0o700, flag: "wx" });
}

// ── Surface primitives ──

/**
 * Create a surface for a subagent and return its encoded handle
 * (`<mux>:<native-id>`).
 */
export function createSurface(
  name: string,
  mode: DisplayMode = "splitRight",
  options?: { fromSurface?: string },
): string {
  const adapter = requireAdapter();
  const nativeId = adapter.create({ name, mode, fromSurface: options?.fromSurface });
  return encodeHandle(adapter.mux, nativeId);
}

/**
 * Create a split in the given direction. `left`/`up` are tmux-only; every
 * other backend maps them onto the nearest supported direction.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  if (activeMux() === "tmux" && (direction === "left" || direction === "up")) {
    const { createSurfaceSplitLegacy } = tmuxModule;
    return encodeHandle("tmux", createSurfaceSplitLegacy(name, direction, fromSurface));
  }
  const mode: DisplayMode =
    direction === "left" || direction === "right" ? "splitRight" : "splitDown";
  return createSurface(name, mode, { fromSurface });
}

/** Send a command line to a surface and run it. */
export function sendCommand(surface: string, command: string): void {
  const { mux, id } = decodeHandle(surface);
  ADAPTERS[mux].send(id, command);
}

/**
 * Send a long command to a surface by writing it to a script file first.
 *
 * Scoring long command text through a pane's line discipline wraps and breaks
 * it, so the payload always goes through a file; only `bash <path>` is typed.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );

  writeScriptFile(scriptPath, renderScript(command, options?.scriptPreamble));
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/** Read the screen contents of a surface (sync). */
export function readScreen(surface: string, lines = 50): string {
  const { mux, id } = decodeHandle(surface);
  return ADAPTERS[mux].read(id, lines);
}

/** Read the screen contents of a surface (async). */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const { mux, id } = decodeHandle(surface);
  return ADAPTERS[mux].readAsync(id, lines);
}

/** Close a surface. */
export function closeSurface(surface: string): void {
  const { mux, id } = decodeHandle(surface);
  ADAPTERS[mux].close(id);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
