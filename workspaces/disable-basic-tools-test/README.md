# Disable Basic Tools Test Workspace

This workspace is configured to load only this personal pi extension:

```text
~/pi/extensions/tool-policy/disable-basic-tools.ts
```

The extension disables these four basic built-in tools:

- `bash`
- `read`
- `edit`
- `write`

## Test

Run pi from this directory:

```bash
cd ~/pi/workspaces/disable-basic-tools-test
pi
```

Then ask the agent to read, write, edit, or run a shell command. Those tool calls should be unavailable or blocked by the policy extension.

## Project config

The project-local pi config is:

```text
.pi/settings.json
```
