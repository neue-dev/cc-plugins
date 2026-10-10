# cc-plugins

My custom Claude Code plugins, in one repository that is also a plugin marketplace.

## Plugins

| Plugin | What it does |
| --- | --- |
| [cc-prompt-queue](plugins/cc-prompt-queue/README.md) | `/q <prompt>` queues a prompt until Claude's current turn has fully ended, then runs it as its own turn, one at a time |

## Install

Add this folder as a marketplace once, then install any plugin from it:

```sh
claude plugin marketplace add ./
claude plugin install <plugin>@cc-plugins
```

Plugins install at user scope, so they load in every new session. Since the marketplace is a local folder, Claude Code reads each plugin straight from `plugins/<plugin>/`: an edit reaches a running session after `/reload-plugins`, with no reinstall.

## Adding a plugin

1. Make a folder `plugins/<plugin>/` with at least `.claude-plugin/plugin.json`:

   ```json
   { "name": "<plugin>", "version": "0.1.0", "description": "<one line>" }
   ```

   Plus whatever the plugin is made of: `hooks/`, `commands/`, `skills/`, `agents/`, a `README.md`.

2. List it in `.claude-plugin/marketplace.json` under `plugins`:

   ```json
   { "name": "<plugin>", "source": "./plugins/<plugin>", "description": "<one line>" }
   ```

3. Add a row to the table above.

4. Check it, then install it:

   ```sh
   claude plugin validate .
   claude plugin marketplace update cc-plugins
   claude plugin install <plugin>@cc-plugins
   ```

Plugin names can't start with `claude-`, `anthropic-` or `cc-plugin-`; the `cc-` prefix used here is fine.
