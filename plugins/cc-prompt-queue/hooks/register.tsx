import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

// What waits, in order. Each entry is one prompt, or a slash command when it starts with /.
const queue = atom({ plugin: 'cc-prompt-queue', key: 'queue' } as const, [] as string[])
// Set by Esc, a failed turn or /q pause: nothing goes out until /q resume.
const isPaused = atom({ plugin: 'cc-prompt-queue', key: 'isPaused' } as const, false)
// From a main-loop turn's start (or our own send) until that turn has ended.
const isBusy = atom({ plugin: 'cc-prompt-queue', key: 'isBusy' } as const, false)
// The entries /q edit put in the prompt box, out of the queue until the edit is saved or
// cancelled; null when no edit is open.
const held = atom({ plugin: 'cc-prompt-queue', key: 'held' } as const, null as string[] | null)

const NAME = 'cc-prompt-queue'
const SUBCOMMANDS = ['edit', 'clear', 'pause', 'resume'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

// A line of /q's arguments that opens another entry: `/q a` then `/q b` on the next line.
const ENTRY_LINE = /^\/q(?:[ \t]+|$)/
const COMMAND = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/
// The record Claude Code keeps of a /q run, which the model would otherwise read mid-turn.
const RECORD = /<command-name>\/q<\/command-name>|^\/q(?:\s|$)/
const RECORD_NOTE = '[The user ran /q, which holds a message in the cc-prompt-queue plugin until this turn ends. There is nothing to act on.]'

const SHOWN = 5
const EDIT_POLL_MS = 300
// Polls in a row that must see an empty box before an open edit counts as abandoned.
// Enter empties the box too, a moment before /q runs and saves the edit.
const EMPTY_POLLS = 3

function toast($: EngineInterface, text: string) {
  $.ui.toast(`${NAME}: ${text}`)
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

// Splits /q's arguments into entries: each line opening with /q starts a new one, and the
// lines below it belong to it.
function parseEntries(args: string): string[] {
  const entries: string[][] = [[]]
  for (const line of args.split('\n')) {
    if (ENTRY_LINE.test(line)) {
      entries.push([line.replace(ENTRY_LINE, '')])
      continue
    }
    entries[entries.length - 1]?.push(line)
  }

  return entries.map(lines => lines.join('\n').trim()).filter(entry => entry !== '')
}

function asCommand(entry: string): { command: string; args: string } | undefined {
  const match = COMMAND.exec(entry)
  if (!match) {
    return undefined
  }
  const [, command = '', args = ''] = match

  return { command, args }
}

function preview(entry: string, width: number): string {
  const line = entry.split('\n')[0] ?? ''
  const isCut = line.length > width || entry.includes('\n')

  return isCut ? `${line.slice(0, width)}…` : line
}

// A queued entry led by / must name a real command: the host will not send a plugin's
// prompt that starts with /, so a path or a typo is refused when queued, not when its turn comes.
async function findUnknown($: EngineInterface, entries: string[]): Promise<string | undefined> {
  const leading = entries.filter(entry => entry.startsWith('/'))
  if (leading.length === 0) {
    return undefined
  }
  const known = new Set((await $.command.list()).map(c => c.name))

  return leading.find(entry => !known.has(asCommand(entry)?.command ?? ''))?.split(/\s/)[0]
}

let isSending = false
// Counts turn starts, so a queued command can tell whether it began a turn (a skill) or not (/compact).
let turnsStarted = 0
// Set when a compaction a queued command started was skipped; /compact cancelled by Esc
// resolves like one that ran, so only the compaction tells them apart.
let compactSkip: string | undefined
let editWatch: Timer | undefined
let emptyPolls = 0

// The queue when a /clear ended the session. The next session starts with fresh state and
// no session.start, so the first thing to run after it puts this back.
let carried: { entries: string[]; isPaused: boolean } | undefined

async function restoreCarried($: EngineInterface) {
  const kept = carried
  if (kept === undefined) {
    return
  }
  carried = undefined
  // Had the state come through the /clear, the queue would already hold these.
  if ((await read($, queue)).length > 0) {
    return
  }
  await update($, queue, () => kept.entries)
  if (kept.isPaused) {
    await update($, isPaused, () => true)
  }
}

async function registerCommand($: EngineInterface) {
  await $.command.register({
    name: 'q',
    description: 'Queue a prompt to run after the current turn ends (/q edit · clear · pause · resume)',
    argumentHint: '<prompt> | edit | clear | pause | resume',
    immediate: true,
  })
}

async function pause($: EngineInterface, why: string) {
  await update($, isPaused, () => true)
  toast($, `${why}, so the queue is paused. /q resume continues it`)
}

// Runs from the clock, never inside a hook: a submit made from a command.run or
// turn.complete hook would wait on the dispatch that hook holds.
function sendLater($: EngineInterface) {
  $.clock.after(0, () => sendNext($))
}

// Sends the head of the queue once nothing runs; the next goes when that turn has ended.
async function sendNext($: EngineInterface) {
  await restoreCarried($)
  if (isSending || (await read($, isBusy)) || (await read($, isPaused)) || (await read($, held)) !== null) {
    return
  }
  const head = (await read($, queue))[0]
  if (head === undefined) {
    return
  }
  isSending = true
  await update($, queue, q => q.slice(1))
  await update($, isBusy, () => true)
  const command = asCommand(head)
  if (command) {
    isSending = false
    await runCommand($, head, command)
    return
  }
  try {
    // Resolves as the prompt's turn starts, so isSending covers the wait for an idle session.
    const result = await $.prompt.submit({ text: head, asUser: true })
    if (result.drop !== undefined) {
      await putBack($, head, `the prompt was not sent (${result.drop})`)
    }
  } catch (error) {
    await putBack($, head, `the prompt could not be sent (${String(error)})`)
  } finally {
    isSending = false
  }
}

async function putBack($: EngineInterface, entry: string, why: string) {
  await update($, queue, q => [entry, ...q])
  await update($, isBusy, () => false)
  await pause($, why)
}

async function runCommand($: EngineInterface, entry: string, command: { command: string; args: string }) {
  const before = turnsStarted
  compactSkip = undefined
  try {
    await $.command.run(command)
    if (compactSkip !== undefined) {
      await pause($, `${entry} did not finish (${compactSkip})`)
    }
  } catch (error) {
    await pause($, `${entry} failed (${String(error)})`)
  }
  // A command that started a turn is released by that turn's end instead.
  if (turnsStarted === before) {
    await update($, isBusy, () => false)
    sendLater($)
  }
}

function stopEditWatch() {
  editWatch?.cancel()
  editWatch = undefined
  emptyPolls = 0
}

// Ends an open edit with the entries the person saved, ahead of anything queued since.
async function saveEdit($: EngineInterface, entries: string[]) {
  stopEditWatch()
  await update($, queue, q => [...entries, ...q])
  await update($, held, () => null)
  sendLater($)
}

// An edit whose box was emptied without saving puts the queue back as it was.
async function watchEdit($: EngineInterface) {
  const entries = await read($, held)
  if (entries === null) {
    stopEditWatch()
    return
  }
  if ((await $.prompt.read()).text.trim() !== '') {
    emptyPolls = 0
    return
  }
  emptyPolls++
  if (emptyPolls >= EMPTY_POLLS) {
    await saveEdit($, entries)
    toast($, 'edit cancelled, the queue is unchanged')
  }
}

async function editQueue($: EngineInterface): Promise<string | undefined> {
  if ((await read($, held)) !== null) {
    return 'already editing: Enter saves the box, emptying it cancels'
  }
  const entries = await read($, queue)
  if (entries.length === 0) {
    return 'nothing is queued'
  }
  if ((await $.prompt.read()).text.trim() !== '') {
    return 'empty the prompt box first, then run /q edit'
  }
  await update($, held, () => entries)
  await update($, queue, () => [])
  const filled = await $.prompt.fill({ text: entries.map(entry => `/q ${entry}`).join('\n') })
  if (!filled.isFilled) {
    await saveEdit($, entries)
    return 'the prompt box could not take the queue, so it is unchanged'
  }
  stopEditWatch()
  editWatch = $.clock.every(EDIT_POLL_MS, () => watchEdit($))

  return undefined
}

async function clearQueue($: EngineInterface): Promise<string> {
  const count = ((await read($, held)) ?? []).length + (await read($, queue)).length
  stopEditWatch()
  await update($, queue, () => [])
  await update($, held, () => null)
  await update($, isPaused, () => false)

  return count === 0 ? 'nothing is queued' : `removed ${plural(count, 'queued prompt')}`
}

async function resume($: EngineInterface): Promise<string> {
  if (!(await read($, isPaused))) {
    return 'the queue is not paused'
  }
  await update($, isPaused, () => false)
  sendLater($)
  const count = (await read($, queue)).length

  return count === 0 ? 'resumed' : `resumed, ${plural(count, 'prompt')} waiting`
}

async function pauseQueue($: EngineInterface): Promise<string> {
  if (await read($, isPaused)) {
    return 'the queue is already paused'
  }
  await update($, isPaused, () => true)

  return `paused with ${plural((await read($, queue)).length, 'prompt')} waiting. /q resume continues it`
}

async function runSubcommand($: EngineInterface, action: Subcommand): Promise<string | undefined> {
  switch (action) {
    case 'edit':
      return editQueue($)
    case 'clear':
      return clearQueue($)
    case 'pause':
      return pauseQueue($)
    case 'resume':
      return resume($)
  }
}

async function onQueueCommand($: EngineInterface, args: string, isFromBox: boolean): Promise<string | undefined> {
  await restoreCarried($)
  const action = args.trim()
  if ((SUBCOMMANDS as readonly string[]).includes(action)) {
    return runSubcommand($, action as Subcommand)
  }
  const entries = parseEntries(args)
  // Enter on the box an edit filled saves it, whatever is left; a bare /q there removes them all.
  if (isFromBox && (await read($, held)) !== null) {
    await saveEdit($, entries)
    const waiting = (await read($, queue)).length

    return entries.length === 0 ? 'removed every edited prompt' : `queue saved, ${plural(waiting, 'prompt')} waiting`
  }
  if (entries.length === 0) {
    if (await read($, isPaused)) {
      return resume($)
    }
    if ((await read($, queue)).length > 0) {
      return editQueue($)
    }

    return 'usage: /q <prompt>, or /q edit · clear · pause · resume'
  }
  const unknown = await findUnknown($, entries)
  if (unknown !== undefined) {
    return `${unknown} is not a command, so nothing was queued. Start the prompt with a word instead`
  }
  const isIdle = !(await read($, isBusy)) && !isSending && (await read($, queue)).length === 0
  const paused = await read($, isPaused)
  await update($, queue, q => [...q, ...entries])
  sendLater($)
  if (paused) {
    return `queued, but the queue is paused (${plural((await read($, queue)).length, 'prompt')} waiting). /q resume continues it`
  }
  if (isIdle) {
    return entries.length === 1 ? undefined : `sending the first now, ${plural(entries.length - 1, 'prompt')} queued after it`
  }

  return `queued, ${plural((await read($, queue)).length, 'prompt')} waiting`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($)
    // A reload keeps the queue; anything left waiting with nothing running goes on.
    sendLater($)

    return next(e)
  })

  // Answers in a toast, never as output text: the model reads a command's output.
  on('command.run', { command: 'q' }, async ($, e) => {
    const isFromBox = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const text = await onQueueCommand($, e.args, isFromBox)
    if (text !== undefined) {
      toast($, text)
    }

    return {}
  })

  // Claude Code records each /q run in the conversation; a run typed mid-turn would reach
  // the model at its next step and could steer the turn, so the record says nothing.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined || (e.door !== 'command' && e.door !== 'prompt')) {
      return next(e)
    }
    const isQueueRecord = e.message.content.some(
      block => block.type === 'text' && typeof block.text === 'string' && RECORD.test(block.text),
    )
    if (!isQueueRecord) {
      return next(e)
    }
    const content = e.message.content.map(block => (block.type === 'text' ? { ...block, text: RECORD_NOTE } : block))

    return next({ ...e, message: { ...e.message, content } })
  })

  on('session.compact', async ($, e, next) => {
    try {
      const result = await next(e)
      if ('skip' in result && result.skip !== undefined) {
        compactSkip = result.skip
      }

      return result
    } catch (error) {
      compactSkip = String(error)
      throw error
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const entries = [...((await read($, held)) ?? []), ...(await read($, queue))]
      carried = entries.length > 0 ? { entries, isPaused: await read($, isPaused) } : undefined
      stopEditWatch()
      // No session.start follows a /clear: register /q again and bring the queue back.
      $.clock.after(250, async () => {
        await registerCommand($)
        await restoreCarried($)
        sendLater($)
      })
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnsStarted++
    await update($, isBusy, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      return result
    }
    await update($, isBusy, () => false)
    const waiting = (await read($, queue)).length + ((await read($, held))?.length ?? 0)
    if (e.reason !== 'answer' && waiting > 0 && !(await read($, isPaused))) {
      await pause($, e.reason === 'aborted' ? 'the turn was interrupted' : `the turn ended with ${e.reason === 'error' ? 'an error' : 'a refusal'}`)
    }
    sendLater($)

    return result
  })

  // /q rows are kept out of the transcript; the band above the prompt shows the queue.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) =>
    RECORD.test(e.props.text.trim()) ? $.ui.resolve(e).Box({}) : next(e),
  )
  on('ui.render', { component: 'CommandOutput' }, ($, e, next) =>
    e.props.command === 'q' ? $.ui.resolve(e).Box({}) : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const entries = await read($, queue)
    const editing = await read($, held)
    if (entries.length === 0 && editing === null) {
      return next(e)
    }
    const paused = await read($, isPaused)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 8)
    const hint = paused
      ? '/q resume · /q edit · /q clear'
      : e.props.isWorking
        ? 'next runs when this turn ends · /q edit · /q clear'
        : '/q edit · /q pause · /q clear'

    return (
      <Box flexDirection="column">
        {editing !== null && (
          <Text color="suggestion">
            {`✎ editing ${plural(editing.length, 'queued prompt')}: Enter saves · delete a line to drop it · empty the box to cancel`}
          </Text>
        )}
        {entries.length > 0 && (
          <Text>
            <Text color={paused ? 'warning' : 'suggestion'} bold>
              {paused ? `⏸ queue paused (${entries.length})` : `queue (${entries.length})`}
            </Text>
            <Text dimColor>{` ${hint}`}</Text>
          </Text>
        )}
        {entries.slice(0, SHOWN).map((entry, i) => (
          <Text key={`entry-${i}`} dimColor>
            {`  ${i + 1}. ${preview(entry, width)}`}
          </Text>
        ))}
        {entries.length > SHOWN && <Text dimColor>{`  +${entries.length - SHOWN} more`}</Text>}
      </Box>
    )
  })
}
