# cc-prompt-queue

A Claude Code plugin for a real prompt queue. Send `/q <prompt>` while Claude works. The prompt waits until the current turn has completely ended, then runs as a turn of its own, one at a time, in order.

## Why

A prompt you send while Claude is working normally **steers the current turn**: Claude Code hands it to Claude as soon as the running tool calls finish. That's right for a correction. It isn't right for "when you're done, do this next", because the new request gets mixed into the task in progress.

| While Claude is working, you send | What happens |
| --- | --- |
| `fix the typo too` | steers the current turn (Claude Code's default) |
| `/q fix the typo too` | waits until the turn has fully ended, then runs as its own turn |

With nothing running and nothing waiting, `/q` sends the prompt right away.

## Usage

```
/q run the tests and fix anything that fails
```

The queue shows above the prompt box:

```
queue (2) next runs when this turn ends · /q edit · /q clear
  1. run the tests and fix anything that fails
  2. update the changelog
```

**Queue several at once.** Each line starting with `/q` is a separate prompt. Lines without it belong to the prompt above them:

```
/q fix the failing tests
and keep the changes small
/q update the changelog
/q summarise what changed
```

**Queue a command.** A queued `/command` runs as that command when its turn comes:

```
/q build the feature
/q /compact
/q write the docs for it
```

The queue survives `/clear`, so `/q /clear` followed by `/q start the next task` gives the next task a fresh conversation.

## Managing the queue

| Type | What it does |
| --- | --- |
| `/q edit` | Puts every queued prompt back in the prompt box, one `/q` line each. Change, reorder or delete lines, then press Enter to save. Empty the box to cancel and keep the queue as it was. Nothing is sent while an edit is open. |
| `/q clear` | Drops everything that's waiting. |
| `/q pause` | Stops the queue from sending. |
| `/q resume` | Starts a paused queue again. |
| `/q` | Resumes a paused queue, otherwise opens the edit. |

**Automatic pausing.** If you press Esc to interrupt Claude, or a turn ends with an error, the queue pauses so nothing runs on its own. A queued command that fails pauses it too. `/q resume` carries on.

## Good to know

- `/q` runs the moment you press Enter, even mid-turn. Claude never sees what you queued until its turn comes: the plugin replaces Claude Code's record of the `/q` run with a short note and hides the `/q` row from the transcript.
- Queued prompts are sent as your own words, but `@file` mentions reach Claude as plain text without the file attached, and images can't be queued.
- A queued prompt can't start with a `/` that isn't a command, such as a path. Put a word first: `/q read /tmp/log.txt`.
- Built on the Claude Code mod API, which is in early access and may change between releases. Needs Claude Code 2.1.295 or newer.

## Install

From this folder:

```sh
claude plugin marketplace add ./
claude plugin install cc-prompt-queue@cc-prompt-queue
```

Start a new session and try `/q hello`. Because the marketplace is this folder, edits here reach a running session after `/reload-plugins`.

To turn it off or remove it:

```sh
claude plugin disable cc-prompt-queue@cc-prompt-queue
claude plugin uninstall cc-prompt-queue@cc-prompt-queue && claude plugin marketplace remove cc-prompt-queue
```

## Develop

```sh
claude --plugin-dir .      # one session with this copy loaded
claude plugin validate .
claude plugin test .
```
