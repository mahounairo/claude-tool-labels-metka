import { expect, test } from 'claude-code/testing'

// A llama-server stand-in: streams the label word by word, with each token's log probability.
function server(words: string[], logprob = -0.01) {
  return async function* () {
    for (const w of words) yield { stream: 'stdout' as const, text: `data: ${JSON.stringify({ content: w, completion_probabilities: [{ logprob }] })}\n\n` }
    return { value: { code: 0, signal: null } }
  }
}

// The plugin's store, kept in a Map for one test.
function store(on: any, kept = new Map<string, unknown>()) {
  on('store.get', (_$: any, e: any) => ({ value: kept.get(e.key) }))
  on('store.set', (_$: any, e: any) => (kept.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$: any, e: any) => (kept.delete(e.key), { value: undefined }))
  return kept
}

const row = (id: string, isRunning: boolean) => ({
  plugin: 'metka',
  component: 'ToolUse',
  props: { tool_use_id: id, tool: 'Bash', input: { command: 'ls -la /etc' }, isRunning, isErrored: false, isInterrupted: false },
} as const)

test('the label replaces the command in the row, then its past tense', async ($, on) => {
  store(on)
  let asked = 0
  on('process.spawn', async function* (_$: any, e: any) {
    asked++
    const past = String(e.input).includes('<state>finished')
    return yield* server(past ? ['Listed', ' files', ' in', ' /etc'] : ['List', ' files', ' in', ' /etc'])()
  } as any)
  on('tool.call', () => ({ result: {} }))

  const call = await $.tool.call({ tool: 'Bash', command: 'ls -la /etc', tool_use_id: 't1' } as any)
  expect(call.isError).not.toBe(true)
  await new Promise(r => (globalThis as any).setTimeout(r, 50))
  expect(asked).toBe(2)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...row('t1', false), surface })
    expect((await ui.find({ type: 'Text', text: /Listed files in \/etc/ }))?.text).toContain('Listed files in /etc')
    await ui.unmount()
  }
})

test('an unsure label leaves the row as it was', async ($, on) => {
  store(on)
  on('process.spawn', server(['Search', ' src', ' for', ' TODO'], -3) as any)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Bash', command: 'grep -rn TODO src/', tool_use_id: 't2' } as any)
  await new Promise(r => (globalThis as any).setTimeout(r, 50))
  const ui = await $.ui.mount({ ...row('t2', false), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Search/ })).toBeUndefined()
  await ui.unmount()
})

test('Bash is told to leave descriptions out', async ($, on) => {
  on('tool.describe', (_$, e) => ({ description: e.description }))
  const d = await $.tool.describe({ tool: 'Bash', description: 'Runs a command.', provider: { plugin: 'engine', tier: 'core' } } as any)
  expect(d.description).toContain('Leave out the `description` parameter')
})

test('labels come from the address chosen in /metka unless /config names another', async ($, on) => {
  store(on, new Map([['url', 'http://192.0.2.10:8080/']]))
  const asked: string[] = []
  on('process.spawn', async function* (_$: any, e: any) {
    asked.push(e.argv[e.argv.length - 1])
    return yield* server(['List', ' files'])()
  } as any)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't3' } as any)
  await new Promise(r => (globalThis as any).setTimeout(r, 50))
  expect(asked[0]).toBe('http://192.0.2.10:8080/completion')
})

test('a first session with no labeller says how to set one up, once', async ($, on) => {
  const kept = store(on)
  const toasts: string[] = []
  on('process.spawn', async function* () { return { value: { code: 7, signal: null } } } as any)
  on('command.register', () => ({ value: {} }) as any)
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }) as any)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  for (const _ of [1, 2]) {
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
    await new Promise(r => (globalThis as any).setTimeout(r, 50))
  }
  expect(toasts.filter(t => t.includes('/metka')).length).toBe(1)
  expect(kept.get('hinted')).toBe(true)
})
