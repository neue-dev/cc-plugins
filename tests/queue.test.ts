import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// Stands in for the engine beneath the plugin: records what it sends, runs and shows.
async function harness($: Engine, on: On) {
  let box = ''
  const sent: string[] = []
  const ran: string[] = []
  const toasts: string[] = []
  const flags = { startsTurn: false, failCommand: false, refuseSubmit: false }

  on('prompt.submit', (_$, e) => {
    if (flags.refuseSubmit) {
      return { drop: 'refused below' } as never
    }
    sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }) as never)
  on('prompt.fill', (_$, e) => {
    box = e.mode === 'append' ? box + e.text : e.text
    return { isFilled: true } as never
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.list', () => ({ value: ['compact', 'clear', 'q'].map(name => ({ name, description: '', source: 'builtin' })) }) as never)
  on('command.register', (_$, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  for (const command of ['compact', 'clear']) {
    on('command.run', { command }, async (_$, e) => {
      ran.push(`/${e.command} ${e.args}`.trim())
      if (flags.failCommand) {
        throw new Error('no')
      }
      if (flags.startsTurn) {
        await turnStart()
      }
      return { text: '' }
    })
  }
  on('session.start', (_$, e) => e as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('ui.render', { component: 'AbovePrompt' }, (_$, e) => h(_$.ui.resolve(e).Box, {}) as never)

  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(0)

  const turnStart = async () => {
    await $.turn.start({ text: 'work', turnId: 't' })
    await clock.advance(0)
  }
  const turnEnd = async (reason: 'answer' | 'aborted' | 'error' = 'answer') => {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't', reason } as never)
    await clock.advance(0)
  }
  // The person typing /q <args> and pressing Enter: Enter empties the box first.
  const q = async (args = '') => {
    box = ''
    await $.command.run({ command: 'q', args, origin: { kind: 'composer' } } as never)
    await clock.advance(0)
  }
  const setBox = (text: string) => {
    box = text
  }
  const boxText = () => box
  const lastToast = () => toasts.at(-1) ?? ''

  return { sent, ran, toasts, flags, q, turnStart, turnEnd, setBox, boxText, lastToast, clock }
}

test('/q with nothing running sends at once', async ($, on) => {
  const s = await harness($, on)
  await s.q('reply APPLE')
  expect(s.sent).toEqual(['reply APPLE'])
})

test('/q mid-turn waits for the turn to end, then runs one prompt per turn in order', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.q('TWO')
  await s.q('THREE')
  expect(s.sent).toEqual([])
  expect(s.lastToast()).toContain('3 prompts waiting')
  await s.turnEnd()
  expect(s.sent).toEqual(['ONE'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.sent).toEqual(['ONE', 'TWO'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.sent).toEqual(['ONE', 'TWO', 'THREE'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.sent).toEqual(['ONE', 'TWO', 'THREE'])
})

test('several /q lines in one submit queue several prompts, continuation lines included', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('fix the tests\nand keep it small\n/q update the changelog')
  await s.turnEnd()
  expect(s.sent).toEqual(['fix the tests\nand keep it small'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.sent).toEqual(['fix the tests\nand keep it small', 'update the changelog'])
})

test('a subagent finishing does not release the next prompt', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId: 'a1' } as never)
  await s.clock.advance(0)
  expect(s.sent).toEqual([])
  await s.turnEnd()
  expect(s.sent).toEqual(['ONE'])
})

test('an interrupted turn pauses the queue until /q resume', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.turnEnd('aborted')
  expect(s.sent).toEqual([])
  expect(s.lastToast()).toContain('interrupted')
  await s.q('resume')
  expect(s.sent).toEqual(['ONE'])
})

test('a failed turn pauses too, and a bare /q resumes', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.turnEnd('error')
  expect(s.sent).toEqual([])
  await s.q()
  expect(s.sent).toEqual(['ONE'])
})

test('/q pause holds the queue and /q resume lets it go', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.q('pause')
  await s.turnEnd()
  expect(s.sent).toEqual([])
  await s.q('resume')
  expect(s.sent).toEqual(['ONE'])
})

test('/q clear drops everything waiting', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.q('TWO')
  await s.q('clear')
  expect(s.lastToast()).toContain('removed 2 queued prompts')
  await s.turnEnd()
  expect(s.sent).toEqual([])
})

test('/q edit puts the queue in the box, and Enter saves the edited version', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.q('TWO')
  await s.q('THREE')
  await s.q('edit')
  expect(s.boxText()).toBe('/q ONE\n/q TWO\n/q THREE')
  // Nothing goes out while the edit is open.
  await s.turnEnd()
  expect(s.sent).toEqual([])
  await s.q('THREE\n/q ONE, changed')
  expect(s.sent).toEqual(['THREE'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.sent).toEqual(['THREE', 'ONE, changed'])
})

test('emptying the box cancels an edit and keeps the queue as it was', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.q('TWO')
  await s.q('edit')
  s.setBox('')
  await s.clock.advance(1000)
  expect(s.lastToast()).toContain('edit cancelled')
  await s.turnEnd()
  expect(s.sent).toEqual(['ONE'])
})

test('a bare /q on an open edit removes every edited prompt', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.q('edit')
  await s.q('')
  expect(s.lastToast()).toContain('removed every edited prompt')
  await s.turnEnd()
  expect(s.sent).toEqual([])
})

test('a queued slash command runs as that command between prompts', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('build it\n/q /compact\n/q write the docs')
  await s.turnEnd()
  expect(s.sent).toEqual(['build it'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.ran).toEqual(['/compact'])
  expect(s.sent).toEqual(['build it', 'write the docs'])
})

test('a queued command that fails pauses the queue', async ($, on) => {
  const s = await harness($, on)
  s.flags.failCommand = true
  await s.turnStart()
  await s.q('/compact\n/q after')
  await s.turnEnd()
  expect(s.ran).toEqual(['/compact'])
  expect(s.sent).toEqual([])
  expect(s.lastToast()).toContain('/compact failed')
})

test('an unknown /command is refused and nothing is queued', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('/tmp/log.txt read this')
  expect(s.lastToast()).toContain('/tmp/log.txt is not a command')
  await s.turnEnd()
  expect(s.sent).toEqual([])
})

test('a prompt the engine refuses goes back to the front and pauses', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  s.flags.refuseSubmit = true
  await s.turnEnd()
  expect(s.lastToast()).toContain('not sent')
  s.flags.refuseSubmit = false
  await s.q('resume')
  expect(s.sent).toEqual(['ONE'])
})

test('the queue survives /clear', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.q('TWO')
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: {} } as never)
  await s.clock.advance(300)
  await s.turnEnd()
  expect(s.sent).toEqual(['ONE'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.sent).toEqual(['ONE', 'TWO'])
})

test('the conversation keeps no trace of what a /q run queued', async ($, on) => {
  const rows = mock.session(on)
  await harness($, on)
  const raise = (text: string) =>
    $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
      door: 'command',
      origin: { kind: 'composer' },
      uuid: crypto.randomUUID(),
    } as never)
  await raise('<command-name>/q</command-name>\n<command-args>delete the database</command-args>')
  await raise('<command-name>/compact</command-name>')
  const texts = rows.appended().flatMap(row => row.message.content.map(block => String(block.text)))
  expect(texts.some(text => text.includes('delete the database'))).toBe(false)
  expect(texts.some(text => text.includes('nothing to act on'))).toBe(true)
  expect(texts).toContain('<command-name>/compact</command-name>')
})

test('the band above the prompt lists what is waiting', async ($, on) => {
  const s = await harness($, on)
  await s.turnStart()
  await s.q('ONE')
  await s.q('TWO')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cc-prompt-queue',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, bodyColumns: 80 },
    } as never)
    expect(await ui.find({ type: 'Text', text: /queue \(2\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\. ONE/ })).toBeDefined()
    await ui.unmount()
  }
})
