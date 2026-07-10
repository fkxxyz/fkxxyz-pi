# Caveman Test Workspace

This workspace tests the local interaction extension stack with Caveman enabled by default.

Loaded extension:

```text
~/pi/extensions/interaction/interaction.ts
```

Manual checks:

- Start pi in this workspace.
- Ask a normal explanatory question; replies should be concise by default (`full`).
- Run `/caveman off`, then ask again; replies should return to normal style.
- Run `/caveman lite`, `/caveman full`, or `/caveman ultra` to switch compression levels.
- Run `/reload`; Caveman should reset to `full`.
