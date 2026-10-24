/**
 * tmux surface adapter.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target the
 * parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than the
 * user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { SurfaceAdapter, SurfaceCreateOptions } from "./types.ts";
import { hasCommand } from "./probe.ts";

export { hasCommand };

const execFileAsync = promisify(execFile);

// ── Availability ──

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 *
 * Only used for split modes; `tab` mode opens a separate window.
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Debounced so a burst of parallel spawns or staggered exits collapses into a
 * single layout call, and non-fatal: a cosmetic resize must never break
 * spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

function tmuxSplit(
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  const target = fromSurface ?? process.env.TMUX_PANE;
  if (target) {
    args.push("-t", target);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/** Legacy helper kept for the tmux integration harness. */
export function createSurfaceSplitLegacy(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  return tmuxSplit(direction, fromSurface);
}

export const tmuxAdapter: SurfaceAdapter = {
  mux: "tmux",

  available: isTmuxAvailable,

  setupHint: () => "Start pi inside tmux (`tmux new -A -s pi 'pi'`).",

  create({ name, mode, fromSurface }: SurfaceCreateOptions): string {
    if (mode === "tab") {
      const target = fromSurface ?? process.env.TMUX_PANE;
      const args = ["new-window", "-d", "-P", "-F", "#{pane_id}"];
      if (target) args.push("-t", target);
      const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
      if (!pane.startsWith("%")) {
        throw new Error(`Unexpected tmux new-window output: ${pane}`);
      }
      void name; // tmux windows are not renamed; the pi process shows its own title.
      return pane;
    }
    return tmuxSplit(mode === "splitRight" ? "right" : "down", fromSurface);
  },

  send(id: string, command: string): void {
    // Typed literally (`-l`) so special characters are not interpreted as keys,
    // then submitted with Enter.
    execFileSync("tmux", ["send-keys", "-t", id, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", id, "Enter"], { encoding: "utf8" });
  },

  read(id: string, lines: number): string {
    return execFileSync(
      "tmux",
      // -J joins lines the pane wrapped, so callers can match text regardless
      // of how narrow the pane happens to be.
      ["capture-pane", "-p", "-J", "-t", id, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
  },

  async readAsync(id: string, lines: number): Promise<string> {
    const { stdout } = await execFileAsync(
      "tmux",
      // -J joins lines the pane wrapped, so callers can match text regardless
      // of how narrow the pane happens to be.
      ["capture-pane", "-p", "-J", "-t", id, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  },

  close(id: string): void {
    execFileSync("tmux", ["kill-pane", "-t", id], { encoding: "utf8" });
    rebalanceSurfaces();
  },
};
