/**
 * Cheap CLI availability probe shared by the surface adapters.
 *
 * Results are cached per process: a missing binary does not appear later in
 * the same session, and `command -v` spawns a shell each time otherwise.
 */
import { execFileSync } from "node:child_process";

const commandAvailability = new Map<string, boolean>();

export function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}
