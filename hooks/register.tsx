// Metka for Claude Code: a short label for each Bash command, from a small model on a llama-server (or any server
// with the OpenAI completions API). The label writes itself over the greyed command as it streams in; when the
// command ends it turns into its past tense or "Failed to ...". Expanded rows (ctrl+o) show the command as usual.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Label } from '../types'
import { DEFAULT_URL, metka, probe, start, urlOf } from './setup'

const labels = atom({ plugin: 'metka', key: 'labels' } as const, {} as Record<string, Label>, { shape: 'labels-1' })
const ARGS_MAX = 3000
const KEEP = 300
const SKIP_LINE = '\n\nLeave out the `description` parameter: a local model writes a short label for each command.'
// Where an unsure label may be cut: words that start a new part of an English label ("Download x.tar.gz | from ...").
const CUT_WORDS = new Set(['from', 'to', 'around', 'with', 'in', 'on', 'for', 'into', 'and', 'at', 'by', 'using', 'via',
  'as', 'then', 'while', 'after', 'before', 'under', 'inside', 'over', 'through', 'across', 'within', 'without', 'onto', 'or'])

type State = 'running' | 'finished' | 'failed'
type Piece = { content: string; sure: number }

// Servers that answered llama.cpp's own /completion with an HTTP error are asked through /v1/completions instead.
const openai = new Map<string, string>()
const warned = new Set<string>()
// The installed server being started by this session: labels wait for it rather than fail.
let starting: Promise<unknown> | undefined

// JSON as python's json.dumps writes it (", " and ": "), which is what the model saw in training.
function pyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(', ')}}`
  return JSON.stringify(v) ?? 'null'
}

function prompt(command: string, state: State, running?: string) {
  let json = pyJson({ command })
  if (json.length > ARGS_MAX) json = json.slice(0, ARGS_MAX) + ' [...]'
  const was = running && state !== 'running' ? `<running>${running}</running>\n` : ''
  return `<tool>bash</tool>\n<args>${json}</args>\n${was}<state>${state}</state>\n<label>`
}

// The confident start of a label that turned unsure at `next`: up to its last cut word, if two words are left.
function keepBefore(text: string, next: string) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (CUT_WORDS.has(next.trim().toLowerCase()) && words.length >= 2) return words.join(' ')
  for (let n = words.length - 1; n >= 2; n--) if (CUT_WORDS.has((words[n] ?? '').toLowerCase())) return words.slice(0, n).join(' ')
  return undefined
}

async function modelOf($: any, url: string) {
  try {
    const ids: string[] = (JSON.parse((await $.http.fetch(`${url}/v1/models`)).text).data ?? []).map((m: any) => m.id)
    return ids.find(id => /metka/i.test(id)) ?? ids[0] ?? 'metka'
  } catch { return 'metka' }
}

// The label's pieces as the server streams them, each with its least likely token's probability. Streamed through
// curl, as a plugin's own fetch hands back the whole body at once.
async function* pieces($: any, url: string, text: string, min: number): AsyncGenerator<Piece> {
  const model = openai.get(url)
  const body = model
    ? { model, prompt: text, max_tokens: 32, temperature: 0, stop: ['</label>'], stream: true, ...(min > 0 ? { logprobs: 1 } : {}) }
    : { prompt: text, n_predict: 32, temperature: 0, stop: ['</label>'], cache_prompt: true, stream: true, n_probs: min > 0 ? 1 : 0 }
  const child = $.process.spawn({
    argv: ['curl', '-sN', '--fail', '--max-time', '30', '-H', 'Content-Type: application/json', '--data-binary', '@-',
      `${url}${model ? '/v1/completions' : '/completion'}`],
    input: JSON.stringify(body),
  })
  const it = child[Symbol.asyncIterator]()
  let buf = ''
  let got = false
  let err = ''
  try {
    for (let r = await it.next(); ; r = await it.next()) {
      if (r.done) {
        if (r.value?.code === 22 && !got && !model) {
          openai.set(url, await modelOf($, url))
          yield* pieces($, url, text, min)
          return
        }
        if (!got) throw new Error(`curl ended with ${r.value?.code}${err ? `: ${err.trim().slice(0, 120)}` : ''}`)
        return
      }
      if (r.value.stream !== 'stdout') { err += r.value.text; continue }
      buf += r.value.text
      let at: number
      while ((at = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, at).trim()
        buf = buf.slice(at + 1)
        if (!line.startsWith('data:')) continue
        if (line.slice(5).trim() === '[DONE]') return
        const msg = JSON.parse(line.slice(5))
        const choice = msg.choices?.[0]
        const content: string | undefined = model ? choice?.text : msg.content
        got = true
        if (!content) continue
        const lp = choice?.logprobs
        const logprobs: number[] = model ? lp?.token_logprobs ?? (lp?.content ?? []).map((t: any) => t.logprob)
          : (msg.completion_probabilities ?? []).map((t: any) => t.logprob ?? 0)
        yield { content, sure: Math.min(...logprobs.map(x => Math.exp(x ?? 0)), 1) }
      }
    }
  } finally {
    await it.return?.()
  }
}

function setLabel($: any, id: string, label: Label) {
  return update($, labels, all => {
    const next = { ...all, [id]: label }
    const ids = Object.keys(next)
    for (const old of ids.slice(0, Math.max(0, ids.length - KEEP))) delete next[old]
    return next
  })
}

// Asks for one state's label and keeps it under the call's id. The running label streams into the row; a past one
// replaces the running one only when it is whole. Resolves to the label, or undefined when there is none to show.
async function label($: any, options: any, id: string, command: string, state: State, running?: string) {
  const min = Number(options.minConfidence ?? 0.15)
  await starting
  const url = await urlOf($, options)
  const streams = state === 'running'
  let text = ''
  let unsure = false
  if (streams) await setLabel($, id, { text: '', done: false })
  try {
    for await (const { content, sure } of pieces($, url, prompt(command, state, running), min)) {
      if (sure < min) {
        const kept = keepBefore(text, content)
        if (kept) text = kept
        else unsure = true
        break
      }
      text += content
      if (streams) await setLabel($, id, { text, done: false })
    }
    text = unsure ? '' : text.trim()
    if (unsure) await setLabel($, id, { text: '', done: true, unsure: true })
    else if (text) await setLabel($, id, { text, done: true })
    else throw new Error('empty label')
    return text || undefined
  } catch (err) {
    if (streams) await setLabel($, id, { text: '', done: true, error: true })
    if (!warned.has(url)) {
      warned.add(url)
      $.ui.toast(`Metka: no label from ${url} (${err instanceof Error ? err.message : String(err)}). /metka sets up a server.`)
    }
    return undefined
  }
}

export const register: Register = (on, options) => {
  // The installed server is started when nothing answers; with none, a first session says how to get one.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'metka', description: 'Set up or check where Bash labels come from' })
    void (async () => {
      const url = await urlOf($, options)
      if ((await probe($, url)).ok) return
      const server = url === DEFAULT_URL ? await $.store.get('server') : undefined
      if (server) await (starting = start($, server as any))
      else if (!(await $.store.get('hinted'))) {
        await $.store.set('hinted', true)
        $.ui.toast(`Metka: no labeller answers at ${url} yet. /metka sets one up.`)
        warned.add(url)
      }
    })().catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'metka' }, async $ => ({ text: await metka($, options) }))

  on('tool.describe', { tool: 'Bash' }, async ($, e, next) => {
    const described = await next(e)
    return options.skipDescription ? { ...described, description: described.description + SKIP_LINE } : described
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
    const running = label($, options, id, e.command, 'running')
    const ran = await next(e)
    void running.then(was => was && label($, options, id, e.command, ran.deny !== undefined || ran.isError === true ? 'failed' : 'finished', was))
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    const l = (await read($, labels))[p.tool_use_id]
    if (p.tool !== 'Bash' || p.isExpanded) return next(e)
    if (!l || l.error || l.unsure || (l.done && !l.text)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const command = String((p.input as any)?.command ?? '').replace(/\s+/g, ' ').trim()
    const rest = l.done ? '' : command.slice(l.text.length)
    const dot = p.isRunning ? 'inactive' : p.isErrored || p.isInterrupted ? 'error' : 'success'
    return (
      <Box marginTop={1}>
        <Text wrap="truncate">
          <Text color={dot}>● </Text>
          <Text>{l.text}</Text>
          <Text dimColor>{rest}</Text>
        </Text>
      </Box>
    )
  })

  // A collapsed group of calls is drawn as its newest call's label and the count; the engine's own summary ("Ran 3
  // commands") can't show labels, and calls drawn inside an unfolded group get the label as their description.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const all = await read($, labels)
    const shown = (c: { tool: string; tool_use_id?: string }) => {
      const l = c.tool === 'Bash' && c.tool_use_id ? all[c.tool_use_id] : undefined
      return l && !l.error && !l.unsure && (l.text || !l.done) ? l : undefined
    }
    const calls = e.props.calls.map(c => {
      const l = shown(c)
      return l?.done && l.text ? { ...c, input: { ...(c.input as object), description: l.text } } : c
    })
    // The newest call: the running one, else the last, which may still be being written (its command growing).
    const newest = [...e.props.calls].reverse().find(c => c.isRunning) ?? e.props.calls[e.props.calls.length - 1]
    const l = newest && shown(newest)
    const command = String((newest?.input as any)?.command ?? '').replace(/\s+/g, ' ').trim()
    // Before its label comes, a Bash call shows its command greyed, as it is being written; a group whose newest call
    // is another tool keeps the engine's summary.
    if (e.props.isExpanded || !newest || newest.tool !== 'Bash' || (!l && !command)) return next({ ...e, props: { ...e.props, calls } })
    const { Box, Text } = $.ui.resolve(e)
    const n = e.props.calls.length
    const failed = e.props.calls.some(c => c.isErrored || c.isInterrupted)
    const dot = e.props.isActive ? 'inactive' : failed ? 'error' : 'success'
    const text = l?.text ?? ''
    return (
      <Box marginTop={1}>
        <Text wrap="truncate">
          <Text color={dot}>● </Text>
          <Text>{text}</Text>
          <Text dimColor>{l?.done ? '' : command.slice(text.length)}{n > 1 ? ` · ${n} calls` : ''}</Text>
        </Text>
      </Box>
    )
  })
}
