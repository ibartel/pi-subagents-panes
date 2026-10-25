/**
 * Regression test for the plan-mode architect loadout.
 *
 * `architect.mode: "plan"` must withdraw the spawning toolset even though the
 * bundled architect.md declares `subagent_agents`. The test drives the same
 * resolver the launch path uses (`resolveSubagentToolAllowlist`), not a
 * hand-built allowlist, so a regression in the grantSpawning derivation fails.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { parseArchitectConfig } from "../pi-extension/subagents/status.ts";

const testApi = (subagentsModule as any).__test__;

const SPAWNING_TOOLS = ["subagent", "subagent_message", "subagents_list"];

function allowlistFor(agentName: string, mode: "plan" | "confirm" | "auto"): string[] {
  const agentDefs = testApi.loadAgentDefaults(agentName);
  assert.ok(agentDefs, `agent definition for "${agentName}" must be loadable`);
  const config = parseArchitectConfig({ architect: { mode } });
  const allowlist = testApi.resolveSubagentToolAllowlist(agentName, agentDefs, config);
  assert.equal(typeof allowlist, "string", "a restricted agent must produce an allowlist");
  return allowlist.split(",").map((tool: string) => tool.trim());
}

describe("plan-mode architect loadout", () => {
  it("loads the bundled architect, whose frontmatter declares spawning agents", () => {
    const agentDefs = testApi.loadAgentDefaults("architect");
    assert.ok(agentDefs);
    assert.ok(
      Array.isArray(agentDefs.subagentAgents) && agentDefs.subagentAgents.length > 0,
      "architect.md is expected to declare subagent_agents; the mode, not the file, withdraws spawning",
    );
  });

  it("grants no spawning tools in plan mode, but keeps ask_question and declared tools", () => {
    const tools = allowlistFor("architect", "plan");

    for (const spawning of SPAWNING_TOOLS) {
      assert.ok(!tools.includes(spawning), `plan mode must not grant ${spawning}`);
    }

    assert.ok(tools.includes("ask_question"), "ask_question must survive the restriction");
    for (const declared of ["read", "grep", "find", "ls", "read_only_bash", "models"]) {
      assert.ok(tools.includes(declared), `declared architect tool ${declared} must be present`);
    }
  });

  it("reports grantSpawning=false in plan mode despite declared subagent_agents", () => {
    const agentDefs = testApi.loadAgentDefaults("architect");
    assert.ok(agentDefs);
    const config = parseArchitectConfig({ architect: { mode: "plan" } });
    assert.equal(testApi.resolveGrantSpawning("architect", agentDefs, config), false);
  });

  it("grants the spawning tools under confirm mode, so the negative above is meaningful", () => {
    const tools = allowlistFor("architect", "confirm");
    for (const spawning of SPAWNING_TOOLS) {
      assert.ok(tools.includes(spawning), `confirm mode must grant ${spawning}`);
    }
    assert.ok(tools.includes("ask_question"));
  });
});
