/**
 * Surface layer contract.
 *
 * A "surface" is the terminal pane, tab, or split that hosts a subagent. The
 * extension only ever stores an opaque handle string, so one spawn path works
 * for every supported multiplexer. A handle is `<mux>:<native-id>` — e.g.
 * `tmux:%12`, `herdr:w1:p3`, `orca:term_ab12`. Commands dispatch on the
 * prefix, which keeps a nested subagent (running under its own mux) working
 * even if the parent used a different one.
 */

/** How a subagent should be displayed when it is spawned. */
export type DisplayMode = "tab" | "splitRight" | "splitDown";

export const DISPLAY_MODES: readonly DisplayMode[] = ["tab", "splitRight", "splitDown"];

export type MuxName = "tmux" | "herdr" | "orca";

export const MUX_NAMES: readonly MuxName[] = ["tmux", "herdr", "orca"];

export interface SurfaceCreateOptions {
  /** Cosmetic label for the new tab/pane. */
  name: string;
  /** Where to put the surface. */
  mode: DisplayMode;
  /**
   * Native id of the surface to split from / the tab to open next to.
   * Defaults to the calling pi's own pane.
   */
  fromSurface?: string;
}

export interface SurfaceAdapter {
  readonly mux: MuxName;
  /** True when this process is running inside this multiplexer and its CLI works. */
  available(): boolean;
  /** Human-readable setup instructions shown when spawning is impossible. */
  setupHint(): string;
  /** Create the surface and return its native id (not the encoded handle). */
  create(options: SurfaceCreateOptions): string;
  /** Send a single command line to the surface and run it. */
  send(id: string, command: string): void;
  /** Read the rendered screen synchronously. */
  read(id: string, lines: number): string;
  /** Read the rendered screen asynchronously. */
  readAsync(id: string, lines: number): Promise<string>;
  /** Close the surface. Best-effort callers wrap this in try/catch. */
  close(id: string): void;
}

export function encodeHandle(mux: MuxName, nativeId: string): string {
  return `${mux}:${nativeId}`;
}

export function decodeHandle(handle: string): { mux: MuxName; id: string } {
  const separator = handle.indexOf(":");
  if (separator < 0) {
    throw new Error(
      `Invalid surface handle "${handle}". Expected "<mux>:<id>" (mux: tmux, herdr, orca).`,
    );
  }
  const mux = handle.slice(0, separator) as MuxName;
  const id = handle.slice(separator + 1);
  if (!MUX_NAMES.includes(mux) || id === "") {
    throw new Error(
      `Invalid surface handle "${handle}". Expected "<mux>:<id>" (mux: tmux, herdr, orca).`,
    );
  }
  return { mux, id };
}
