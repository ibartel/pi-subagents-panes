import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPLAY_MODES,
  MUX_NAMES,
  type DisplayMode,
  type MultiplexerPreference,
} from "./surfaces/index.ts";

export const SNAPSHOT_STALLED_AFTER_MS = 60_000;
export const DEFAULT_STATUS_LINE_LIMIT = 4;
export const MAX_STATUS_NAME_LENGTH = 72;
export const MAX_STATUS_LINE_LENGTH = 120;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_STATUS_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const STATUS_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export type SubagentStatusKind = "starting" | "active" | "waiting" | "stalled" | "running";
export type SubagentStatusSource = "pi" | "claude";
export type SubagentStatusTransition = "stalled" | "recovered" | null;
export type StatusSnapshotState = "unseen" | "present" | "missing" | "invalid" | "wrong-id";
export type StatusActivityPhase = "starting" | "active" | "waiting" | "done";

export interface StatusConfig {
  enabled: boolean;
  lineLimit: number;
}

// ── Display config ──────────────────────────────────────────────────────────
// How a subagent's terminal surface is placed. Kept separate from StatusConfig
// so the widget config and the pane-placement config stay independently
// optional, while both live in the same config.json.

export interface DisplayConfig {
  /** Placement for subagents spawned by a top-level pi session. */
  mode: DisplayMode;
  /** Placement for subagents spawned by another subagent. */
  nestedMode: DisplayMode;
  /** Force a multiplexer, or `auto` to detect from the environment. */
  multiplexer: MultiplexerPreference;
}

export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  mode: "splitRight",
  nestedMode: "splitRight",
  multiplexer: "auto",
};

// ── Model / thinking defaults ────────────────────────────────────────────────
// Applies to subagents that do not name a model or thinking level themselves.
// Both keys are optional: leaving them unset means "inherit from the parent
// session", which is the behaviour most people want when they switch models
// with /model and expect spawned agents to follow.

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface DefaultsConfig {
  /** Model selector ("provider/id") for agents that do not set `model:`. Unset = inherit the parent's model. */
  model?: string;
  /** Thinking level for agents that do not set `thinking:`. Unset = inherit the parent's level. */
  thinking?: ThinkingLevelName;
}

export const DEFAULT_DEFAULTS_CONFIG: DefaultsConfig = {};

function isThinkingLevelName(value: unknown): value is ThinkingLevelName {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse the optional `defaults` block. Missing block -> empty defaults.
 */
export function parseDefaultsConfig(rawConfig: unknown, source = "config.json"): DefaultsConfig {
  const config = requireObject(rawConfig, source, "root");
  if (config.defaults === undefined) return { ...DEFAULT_DEFAULTS_CONFIG };

  const defaults = requireObject(config.defaults, source, "defaults");
  rejectUnsupportedKeys(defaults, ["model", "thinking"], source, "defaults");

  const result: DefaultsConfig = {};

  if (defaults.model !== undefined) {
    if (typeof defaults.model !== "string" || defaults.model.trim() === "") {
      invalidStatusConfig(source, "defaults.model must be a non-empty model selector string");
    }
    result.model = defaults.model.trim();
  }

  if (defaults.thinking !== undefined) {
    if (!isThinkingLevelName(defaults.thinking)) {
      invalidStatusConfig(
        source,
        `defaults.thinking must be one of ${THINKING_LEVELS.join(", ")} (got ${JSON.stringify(defaults.thinking)})`,
      );
    }
    result.thinking = defaults.thinking;
  }

  return result;
}

export type StatusObservation =
  | {
      snapshot: "present";
      updatedAt: number;
      sequence: number;
      phase: StatusActivityPhase;
      active?: boolean;
      activeScope?: string;
      activeSince?: number;
      waitingSince?: number;
      latestEvent?: string;
      activityLabel?: string;
    }
  | {
      snapshot: "missing" | "invalid" | "wrong-id";
      snapshotError?: string;
    };

export interface SubagentStatusState {
  source: SubagentStatusSource;
  startTimeMs: number;
  firstObservationAtMs: number | null;
  lastActivityAtMs: number | null;
  lastActivitySequence: number | null;
  localOverrideAtMs: number | null;
  localOverrideSequence: number | null;
  activeNow: boolean;
  activeSinceMs: number | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  phase: StatusActivityPhase | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotProblemSinceMs: number | null;
  snapshotError: string | null;
  currentKind: SubagentStatusKind;
}

export interface StatusSnapshot {
  kind: SubagentStatusKind;
  elapsedMs: number;
  elapsedText: string;
  activeSinceMs: number | null;
  activeDurationText: string | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  waitingDurationText: string | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotError: string | null;
  snapshotProblemText: string | null;
  statusLabel: string | null;
}

export interface CappedStatusLines {
  visibleLines: string[];
  overflow: number;
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, source: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    invalidStatusConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(source, `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function boundStatusLine(line: string): string {
  return truncateText(line.replace(/\s+/g, " ").trim(), MAX_STATUS_LINE_LENGTH);
}

function snapshotProblemLabel(snapshotState: StatusSnapshotState): string | null {
  if (snapshotState === "wrong-id") return "wrong activity id";
  return null;
}

function activityLabel(snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope">): string | null {
  return snapshot.activityLabel ?? snapshot.activeScope;
}

export function parseStatusConfig(rawConfig: unknown, source = "config.json"): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  const status = requireObject(config.status, source, "status");
  rejectUnsupportedKeys(status, ["enabled"], source, "status");
  const enabled = requireBoolean(status.enabled, source, "status.enabled");

  return {
    enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
  };
}

function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === "string" && (DISPLAY_MODES as readonly string[]).includes(value);
}

function isMultiplexerPreference(value: unknown): value is MultiplexerPreference {
  return (
    typeof value === "string" &&
    (value === "auto" || (MUX_NAMES as readonly string[]).includes(value))
  );
}

/**
 * Parse the optional `display` block. Missing block -> defaults.
 * `nestedMode` defaults to `mode` so a single key is a complete configuration.
 */
export function parseDisplayConfig(rawConfig: unknown, source = "config.json"): DisplayConfig {
  const config = requireObject(rawConfig, source, "root");
  if (config.display === undefined) return { ...DEFAULT_DISPLAY_CONFIG };

  const display = requireObject(config.display, source, "display");
  rejectUnsupportedKeys(display, ["mode", "nestedMode", "multiplexer"], source, "display");

  const mode = display.mode === undefined ? DEFAULT_DISPLAY_CONFIG.mode : display.mode;
  if (!isDisplayMode(mode)) {
    invalidStatusConfig(
      source,
      `display.mode must be one of ${DISPLAY_MODES.join(", ")} (got ${JSON.stringify(mode)})`,
    );
  }

  const nestedRaw = display.nestedMode === undefined ? mode : display.nestedMode;
  if (!isDisplayMode(nestedRaw)) {
    invalidStatusConfig(
      source,
      `display.nestedMode must be one of ${DISPLAY_MODES.join(", ")} (got ${JSON.stringify(nestedRaw)})`,
    );
  }

  const multiplexer =
    display.multiplexer === undefined ? DEFAULT_DISPLAY_CONFIG.multiplexer : display.multiplexer;
  if (!isMultiplexerPreference(multiplexer)) {
    invalidStatusConfig(
      source,
      `display.multiplexer must be auto or one of ${MUX_NAMES.join(", ")} (got ${JSON.stringify(multiplexer)})`,
    );
  }

  return { mode, nestedMode: nestedRaw, multiplexer };
}

function readStatusConfigFile(configPath: string, examplePath: string): { sourcePath: string; rawConfig: string } {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        `Missing subagent status config. Expected ${configPath} or ${examplePath}.`,
      );
    }
    throw error;
  }
}

export function loadStatusConfig(
  configPath = DEFAULT_STATUS_CONFIG_PATH,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
): StatusConfig {
  return loadExtensionConfig(configPath, examplePath).status;
}

/** Both config blocks from a single file read. */
export interface ExtensionConfig {
  status: StatusConfig;
  display: DisplayConfig;
  defaults: DefaultsConfig;
  models: ModelsConfig;
  architect: ArchitectConfig;
}

function readParsedConfig(
  configPath: string,
  examplePath: string,
): { sourcePath: string; parsed: unknown } {
  const { sourcePath, rawConfig } = readStatusConfigFile(configPath, examplePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }

  return { sourcePath, parsed };
}

/** Load the status and display config in one pass. */
export function loadExtensionConfig(
  configPath = DEFAULT_STATUS_CONFIG_PATH,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
): ExtensionConfig {
  const { sourcePath, parsed } = readParsedConfig(configPath, examplePath);
  return {
    status: parseStatusConfig(parsed, sourcePath),
    display: parseDisplayConfig(parsed, sourcePath),
    defaults: parseDefaultsConfig(parsed, sourcePath),
    models: parseModelsConfig(parsed, sourcePath),
    architect: parseArchitectConfig(parsed, sourcePath),
  };
}

// ── Model catalog policy (annotations / excludes / tiers) ───────────────────
// The facts (cost, context window, reasoning support) come from pi's model
// registry at runtime. This block only carries what pi cannot know: your own
// judgement about a model, and which models to hide or group.

export interface ModelsConfig {
  /** Free-form notes per model selector, shown to the planner. */
  annotations: Record<string, string>;
  /** Glob-ish selectors (`*experimental*`) never offered to the planner. */
  exclude: string[];
  /** Named shortlists, e.g. `{ cheap: [...], deep: [...] }`. */
  tiers: Record<string, string[]>;
}

export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  annotations: {},
  exclude: [],
  tiers: {},
};

function requireStringArray(value: unknown, source: string, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalidStatusConfig(source, `${fieldName} must be an array of strings`);
  }
  return (value as string[]).map((entry) => entry.trim()).filter(Boolean);
}

export function parseModelsConfig(rawConfig: unknown, source = "config.json"): ModelsConfig {
  const config = requireObject(rawConfig, source, "root");
  if (config.models === undefined) {
    return { annotations: {}, exclude: [], tiers: {} };
  }

  const models = requireObject(config.models, source, "models");
  rejectUnsupportedKeys(models, ["annotations", "exclude", "tiers"], source, "models");

  const result: ModelsConfig = { annotations: {}, exclude: [], tiers: {} };

  if (models.annotations !== undefined) {
    const raw = requireObject(models.annotations, source, "models.annotations");
    for (const [selector, note] of Object.entries(raw)) {
      if (typeof note !== "string") {
        invalidStatusConfig(source, `models.annotations.${selector} must be a string`);
      }
      const trimmed = note.trim();
      if (trimmed) result.annotations[selector.trim()] = trimmed;
    }
  }

  if (models.exclude !== undefined) {
    result.exclude = requireStringArray(models.exclude, source, "models.exclude");
  }

  if (models.tiers !== undefined) {
    const raw = requireObject(models.tiers, source, "models.tiers");
    for (const [tier, models_] of Object.entries(raw)) {
      const entries = requireStringArray(models_, source, `models.tiers.${tier}`);
      for (const entry of entries) {
        // `selector:thinking` is allowed; anything after the last `:` that is not
        // a known level would silently never match a model, so reject it loudly.
        const suffix = entry.includes(":") ? entry.slice(entry.lastIndexOf(":") + 1).trim() : null;
        if (suffix !== null && !isThinkingLevelName(suffix)) {
          invalidStatusConfig(
            source,
            `models.tiers.${tier} entry ${JSON.stringify(entry)} has an invalid thinking level ` +
              `(expected one of ${THINKING_LEVELS.join(", ")})`,
          );
        }
      }
      result.tiers[tier] = entries;
    }
  }

  return result;
}

// ── Architect policy ────────────────────────────────────────────────────────
// How the bundled `architect` agent behaves, and the hard caps every spawning
// process obeys. Caps are enforced in code, not just requested in a prompt.

export const AUTONOMY_MODES = ["plan", "confirm", "auto"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export interface ArchitectConfig {
  /** `plan`: never spawns. `confirm`: asks before spawning. `auto`: spawns immediately. */
  mode: AutonomyMode;
  /** Max subagents one spawning run may launch. 0 disables the cap. */
  maxAgents: number;
  /** Max cascade depth (architect → child → grandchild). 0 disables the cap. */
  maxDepth: number;
}

export const DEFAULT_ARCHITECT_CONFIG: ArchitectConfig = {
  mode: "confirm",
  maxAgents: 4,
  maxDepth: 2,
};

function requireNonNegativeInteger(value: unknown, source: string, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalidStatusConfig(source, `${fieldName} must be a non-negative integer`);
  }
  return value;
}

export function parseArchitectConfig(rawConfig: unknown, source = "config.json"): ArchitectConfig {
  const config = requireObject(rawConfig, source, "root");
  if (config.architect === undefined) return { ...DEFAULT_ARCHITECT_CONFIG };

  const architect = requireObject(config.architect, source, "architect");
  rejectUnsupportedKeys(architect, ["mode", "maxAgents", "maxDepth"], source, "architect");

  const mode = architect.mode === undefined ? DEFAULT_ARCHITECT_CONFIG.mode : architect.mode;
  if (typeof mode !== "string" || !(AUTONOMY_MODES as readonly string[]).includes(mode)) {
    invalidStatusConfig(
      source,
      `architect.mode must be one of ${AUTONOMY_MODES.join(", ")} (got ${JSON.stringify(mode)})`,
    );
  }

  return {
    mode: mode as AutonomyMode,
    maxAgents:
      architect.maxAgents === undefined
        ? DEFAULT_ARCHITECT_CONFIG.maxAgents
        : requireNonNegativeInteger(architect.maxAgents, source, "architect.maxAgents"),
    maxDepth:
      architect.maxDepth === undefined
        ? DEFAULT_ARCHITECT_CONFIG.maxDepth
        : requireNonNegativeInteger(architect.maxDepth, source, "architect.maxDepth"),
  };
}

export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;

  return `${minutes}m`;
}

export function createStatusState(params: {
  source: SubagentStatusSource;
  startTimeMs: number;
}): SubagentStatusState {
  const initialKind = params.source === "claude" ? "running" : "starting";
  return {
    source: params.source,
    startTimeMs: params.startTimeMs,
    firstObservationAtMs: null,
    lastActivityAtMs: null,
    lastActivitySequence: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: null,
    phase: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: params.source === "claude" ? "unseen" : "unseen",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: initialKind,
  };
}

export function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  if (state.source === "claude") return state;

  if (observation.snapshot !== "present") {
    return {
      ...state,
      firstObservationAtMs: state.firstObservationAtMs ?? now,
      snapshotState: observation.snapshot,
      snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
      snapshotError: observation.snapshotError ?? null,
    };
  }

  const updatedAt = observation.updatedAt;
  const sequence = observation.sequence;
  const lastActivityAtMs = state.lastActivityAtMs;
  const lastActivitySequence = state.lastActivitySequence;
  const olderThanLastActivity = lastActivityAtMs != null && (
    updatedAt < lastActivityAtMs ||
    (updatedAt === lastActivityAtMs && lastActivitySequence != null && sequence < lastActivitySequence)
  );
  if (olderThanLastActivity) return state;

  const blockedByLocalOverride = state.localOverrideAtMs != null && (
    updatedAt < state.localOverrideAtMs ||
    (updatedAt === state.localOverrideAtMs && state.localOverrideSequence != null && sequence <= state.localOverrideSequence)
  );
  if (blockedByLocalOverride) return state;

  const phase = observation.phase;
  const activeNow = phase === "active" || observation.active === true;
  const activeSinceMs = activeNow
    ? observation.activeSince ?? state.activeSinceMs ?? updatedAt
    : null;
  const waitingSinceMs = phase === "waiting"
    ? observation.waitingSince ?? state.waitingSinceMs ?? updatedAt
    : null;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: updatedAt,
    lastActivitySequence: sequence,
    activeNow,
    activeSinceMs,
    activeScope: activeNow ? observation.activeScope ?? null : null,
    waitingSinceMs,
    phase,
    latestEvent: observation.latestEvent ?? null,
    activityLabel: observation.activityLabel ?? null,
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
  };
}

export function forceStatusAfterInterrupt(state: SubagentStatusState, now: number): SubagentStatusState {
  if (state.source === "claude") return state;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: now,
    localOverrideAtMs: now,
    localOverrideSequence: state.lastActivitySequence,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: now,
    phase: "waiting",
    latestEvent: "interrupt_requested",
    activityLabel: "interrupted",
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: "waiting",
  };
}

function classifyProblemState(state: SubagentStatusState, now: number): Pick<StatusSnapshot, "kind" | "statusLabel"> {
  const problemLabel = snapshotProblemLabel(state.snapshotState);
  const hasValidSnapshot = state.lastActivityAtMs != null;

  if (!hasValidSnapshot) {
    const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
    const elapsedMs = Math.max(0, now - referenceMs);
    return elapsedMs >= SNAPSHOT_STALLED_AFTER_MS
      ? { kind: "stalled", statusLabel: problemLabel }
      : { kind: "starting", statusLabel: null };
  }

  const problemSinceMs = state.snapshotProblemSinceMs ?? now;
  const problemMs = Math.max(0, now - problemSinceMs);
  if (problemMs >= SNAPSHOT_STALLED_AFTER_MS) return { kind: "stalled", statusLabel: problemLabel };

  const lastHealthyKind = state.activeNow
    ? "active"
    : state.waitingSinceMs != null || state.phase === "done"
      ? "waiting"
      : state.currentKind === "stalled"
        ? "starting"
        : state.currentKind;
  return { kind: lastHealthyKind, statusLabel: problemLabel };
}

export function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs);
  const elapsedText = formatElapsedDuration(elapsedMs);

  if (state.source === "claude") {
    return {
      kind: "running",
      elapsedMs,
      elapsedText,
      activeSinceMs: null,
      activeDurationText: null,
      activeScope: null,
      waitingSinceMs: null,
      waitingDurationText: null,
      latestEvent: null,
      activityLabel: null,
      snapshotState: state.snapshotState,
      snapshotError: null,
      snapshotProblemText: null,
      statusLabel: null,
    };
  }

  let kind: SubagentStatusKind;
  let statusLabel: string | null = null;

  if (state.snapshotState === "present") {
    if (state.phase === "active" || state.activeNow) {
      kind = "active";
    } else if (state.phase === "waiting") {
      kind = "waiting";
    } else if (state.phase === "done") {
      kind = "waiting";
      statusLabel = "done";
    } else {
      const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
      const elapsedSinceObservationMs = Math.max(0, now - referenceMs);
      kind = elapsedSinceObservationMs >= SNAPSHOT_STALLED_AFTER_MS ? "stalled" : "starting";
      statusLabel = null;
    }
  } else {
    const classified = classifyProblemState(state, now);
    kind = classified.kind;
    statusLabel = classified.statusLabel;
  }

  const activeDurationText = state.activeSinceMs == null
    ? null
    : formatElapsedDuration(now - state.activeSinceMs);
  const waitingDurationText = state.waitingSinceMs == null
    ? null
    : formatElapsedDuration(now - state.waitingSinceMs);
  const snapshotProblemText = state.snapshotProblemSinceMs == null
    ? null
    : formatElapsedDuration(now - state.snapshotProblemSinceMs);

  return {
    kind,
    elapsedMs,
    elapsedText,
    activeSinceMs: state.activeSinceMs,
    activeDurationText,
    activeScope: state.activeScope,
    waitingSinceMs: state.waitingSinceMs,
    waitingDurationText,
    latestEvent: state.latestEvent,
    activityLabel: state.activityLabel,
    snapshotState: state.snapshotState,
    snapshotError: state.snapshotError,
    snapshotProblemText,
    statusLabel,
  };
}

export function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState;
  snapshot: StatusSnapshot;
  transition: SubagentStatusTransition;
} {
  const snapshot = classifyStatus(state, now);
  const transition =
    state.currentKind !== "stalled" && snapshot.kind === "stalled"
      ? "stalled"
      : state.currentKind === "stalled" && (snapshot.kind === "active" || snapshot.kind === "waiting")
        ? "recovered"
        : null;

  return {
    snapshot,
    transition,
    nextState: {
      ...state,
      currentKind: snapshot.kind,
    },
  };
}

function formatActiveDetail(snapshot: StatusSnapshot): string {
  const label = activityLabel(snapshot);
  if (!label) return "active";
  const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
  return `active (${label}${duration})`;
}

function formatWaitingDetail(snapshot: StatusSnapshot): string {
  const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
  return `waiting${duration}`;
}

function formatStalledDetail(snapshot: StatusSnapshot): string {
  const detail = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return `stalled${duration}${detail}`;
}

export function formatStatusLine(name: string, snapshot: StatusSnapshot): string {
  const boundedName = normalizeStatusName(name);

  if (snapshot.kind === "starting") {
    const label = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, starting${label}.`);
  }

  if (snapshot.kind === "running") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}.`);
  }

  if (snapshot.kind === "active") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatActiveDetail(snapshot)}.`);
  }

  if (snapshot.kind === "waiting") {
    const problem = snapshot.statusLabel && snapshot.statusLabel !== "done"
      ? ` (${snapshot.statusLabel})`
      : snapshot.statusLabel === "done"
        ? " (done)"
        : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatWaitingDetail(snapshot)}${problem}.`);
  }

  return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatStalledDetail(snapshot)}.`);
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
): string {
  const boundedName = normalizeStatusName(name);

  if (transition === "recovered") {
    const detail = snapshot.kind === "waiting" ? formatWaitingDetail(snapshot) : formatActiveDetail(snapshot);
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, recovered; ${detail}.`);
  }

  return formatStatusLine(boundedName, snapshot);
}

export function capStatusLines(lines: string[], lineLimit: number): CappedStatusLines {
  const visibleLines = lines.slice(0, lineLimit);
  return {
    visibleLines,
    overflow: Math.max(0, lines.length - visibleLines.length),
  };
}

export function formatStatusAggregate(lines: string[], lineLimit: number): string {
  const { visibleLines, overflow } = capStatusLines(lines, lineLimit);
  const bulletLines = visibleLines.map((line) => `• ${line}`);
  if (overflow > 0) bulletLines.push(`• +${overflow} more running.`);
  return `Subagent status:\n${bulletLines.join("\n")}`;
}
