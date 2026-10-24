# Notice

`pi-subagents-panes` is a fork of
[`pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents)
by **HazAT**, via Amos Blomqvist's tmux-only fork
([`amosblomqvist/pi-interactive-subagents`](https://github.com/amosblomqvist/pi-interactive-subagents)).

Upstream is MIT-licensed; the original copyright notice is preserved in
[`LICENSE`](./LICENSE).

## What this fork changes

- Adds Orca and herdr as surface backends next to tmux.
- Makes how subagents are displayed configurable: `tab`, `splitRight`, or
  `splitDown`, with a separate mode for subagents spawned by subagents and a
  per-agent frontmatter override.
- Migrates the pi extension API imports from `@mariozechner/*` to
  `@earendil-works/*` (pi 1.4.0).

The subagent architecture, the multi-multiplexer surface concept, the sandboxed
resume/loadout model, and the status widget originate upstream.

## Third-party names

Herdr and Orca are separate products, not affiliated with this project. The
adapters only shell out to their public CLIs.
