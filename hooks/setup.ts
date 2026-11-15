// /metka: where labels come from, without editing settings by hand. Either a server you already run (its address
// kept in the plugin's store), or one installed here: a pinned llama.cpp release and a Metka model, downloaded into
// ~/.claude/metka and started in the background, shared by every Claude Code session and left running between them.

// A llama.cpp release tested with Metka; newer ones come out several times a day, so new installs don't follow them.
const LLAMA = 'b12387'
const MODELS = {
  '1.7b': { file: 'metka-1.7b-Q8_0.gguf', size: '1.8 GB', url: 'https://huggingface.co/mahounairo/metka-1.7b-gguf/resolve/main/metka-1.7b-Q8_0.gguf' },
  '0.6b': { file: 'metka-0.6b-Q8_0.gguf', size: '640 MB', url: 'https://huggingface.co/mahounairo/metka-0.6b-gguf/resolve/main/metka-0.6b-Q8_0.gguf' },
}
export const DEFAULT_URL = 'http://127.0.0.1:11500'

// What /metka installed: started at each session's start when nothing answers at DEFAULT_URL.
type Server = { binary: string; model: string; gpu: boolean }
type Build = { label: string; asset: string; gpu: boolean }

// Runs a command to its end: its exit code and its output, each stream whole.
async function run($: any, argv: string[], onErr?: (text: string) => void) {
  let out = ''
  let err = ''
  const it = $.process.spawn({ argv })[Symbol.asyncIterator]()
  for (let r = await it.next(); ; r = await it.next()) {
    if (r.done) return { code: r.value?.code as number | null, out, err }
    if (r.value.stream === 'stdout') out += r.value.text
    else { err += r.value.text; onErr?.(r.value.text) }
  }
}

async function home($: any) {
  return `${await $.env.get('HOME')}/.claude/metka`
}

// The settings /metka keeps in the plugin's store. Options the plugin is loaded with (pluginConfigs, for a plugin
// loaded from a folder) win.
export async function minConfidence($: any, options: any) {
  return Number(options.minConfidence ?? (await $.store.get('minConfidence')) ?? 0.15)
}

export async function skipDescription($: any, options: any) {
  return Boolean(options.skipDescription ?? (await $.store.get('skipDescription')) ?? true)
}

// The address labels are asked at: one in settings.json wins, then one chosen in /metka, then the installed server's.
export async function urlOf($: any, options: any) {
  const set = String(options.url || '').replace(/\/+$/, '')
  if (set && set !== DEFAULT_URL) return set
  return String((await $.store.get('url')) || DEFAULT_URL).replace(/\/+$/, '')
}

// llama-server answers /health; any other server with the OpenAI API (Ollama, LM Studio, vLLM...) /v1/models. Asked
// through curl, with a timeout (a plugin's own fetch has none). `wait` keeps asking while the server is starting.
export async function probe($: any, url: string, wait = 0): Promise<{ ok: boolean; model?: string }> {
  const retry = wait ? ['--retry', String(wait), '--retry-connrefused', '--retry-delay', '1'] : []
  for (const path of ['/health', '/v1/models']) {
    try {
      const r = await run($, ['curl', '-s', '--fail', '--max-time', '3', ...retry, `${url}${path}`])
      if (r.code !== 0) continue
      const ids = path === '/health' ? [] : (JSON.parse(r.out).data ?? []).map((m: any) => m.id)
      return { ok: true, model: ids.find((id: string) => /metka/i.test(id)) ?? ids[0] }
    } catch {}
  }
  return { ok: false }
}

async function builds($: any): Promise<Build[]> {
  const { code, out } = await run($, ['uname', '-sm']).catch(() => ({ code: 1, out: '' }))
  const [os, machine] = out.trim().split(/\s+/)
  if (code !== 0) return []
  const arm = /arm64|aarch64/.test(machine ?? '')
  if (os === 'Darwin') return [{ label: 'Apple GPU (Metal)', asset: `macos-${arm ? 'arm64' : 'x64'}`, gpu: arm }]
  if (os !== 'Linux') return []
  const a = arm ? 'arm64' : 'x64'
  return [
    { label: 'CPU', asset: `ubuntu-${a}`, gpu: false },
    { label: 'GPU via Vulkan', asset: `ubuntu-vulkan-${a}`, gpu: true },
  ]
}

// curl's progress meter, read off its stderr: the percentage of the last line it drew.
async function download($: any, url: string, to: string, what: string) {
  let shown = 0
  const { code, err } = await run($, ['curl', '-L', '--fail', '--create-dirs', '-o', `${to}.part`, url], text => {
    const cells = text.split('\r').filter(l => /^\s*\d+\s/.test(l)).pop()?.trim().split(/\s+/)
    if (!cells || Date.now() - shown < 500) return
    shown = Date.now()
    $.ui.status(`downloading ${what}: ${cells[0]}% of ${cells[1]}`)
  })
  if (code !== 0) throw new Error(`downloading ${what} failed (curl ${code}): ${err.trim().split(/[\r\n]/).pop()?.slice(0, 160)}`)
  await run($, ['mv', `${to}.part`, to])
}

// Starts the installed server in the background, outside the session, so it outlives it and the next session finds it.
export async function start($: any, server: Server) {
  const dir = await home($)
  const args = ['-m', server.model, '--port', DEFAULT_URL.split(':').pop()!, '--host', '127.0.0.1', '-ngl', server.gpu ? '99' : '0',
    '-c', '4096', '--parallel', '2', '--alias', 'metka']
  const script = 'cd "$1" && shift && (command -v setsid >/dev/null && exec setsid nohup "$@" || exec nohup "$@") > server.log 2>&1 < /dev/null &'
  await run($, ['sh', '-c', script, 'metka', dir, server.binary, ...args])
  return (await probe($, DEFAULT_URL, 30)).ok
}

async function stop($: any) {
  const server = (await $.store.get('server')) as Server | undefined
  if (!server) return 'Nothing was installed by /metka.'
  const { code } = await run($, ['pkill', '-f', `^${server.binary} -m ${server.model}`])
  const again = (await $.store.get('url')) ? '' : ' The next session starts it again.'
  return code === 0 ? `Stopped the Metka server.${again}` : 'The Metka server was not running.'
}

async function install($: any) {
  const options = await builds($)
  if (!options.length) return 'There is no ready-made llama.cpp for this system here yet. Run a llama-server yourself and pick "Use my own server".'
  const big = 'Metka 1.7B'
  const which = await $.ui.ask(`Which model? 1.7B gives the better labels (${MODELS['1.7b'].size}); 0.6B is lighter, for laptops and older CPUs (${MODELS['0.6b'].size}).`,
    { header: 'Model', options: [big, 'Metka 0.6B'] })
  const model = MODELS[which === big ? '1.7b' : '0.6b']
  let build: Build = options[0]!
  if (options.length > 1) {
    const on = await $.ui.ask('Run it on? CPU works everywhere, about half a second a label on a desktop CPU. Vulkan needs NVIDIA, AMD or Intel graphics with their drivers, and takes a few hundredths of a second.',
      { header: 'Hardware', options: options.map(b => b.label) })
    build = options.find(b => b.label === on) ?? build
  }
  void (async () => {
    try {
      const dir = await home($)
      const llama = `${dir}/llama-${LLAMA}-${build.asset}`
      const find = async () => (await run($, ['find', llama, '-name', 'llama-server', '-type', 'f'])).out.trim().split('\n')[0] || undefined
      let binary = await find()
      if (!binary) {
        const archive = `${llama}.tar.gz`
        await download($, `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA}/llama-${LLAMA}-bin-${build.asset}.tar.gz`, archive, 'llama.cpp')
        await run($, ['mkdir', '-p', llama])
        const x = await run($, ['tar', '-xzf', archive, '-C', llama])
        if (x.code !== 0) throw new Error(`unpacking llama.cpp failed: ${x.err.trim().slice(0, 160)}`)
        await run($, ['rm', '-f', archive])
        binary = await find()
        if (!binary) throw new Error('llama-server is not in the llama.cpp archive')
      }
      const modelPath = `${dir}/models/${model.file}`
      if ((await run($, ['test', '-f', modelPath])).code !== 0) await download($, model.url, modelPath, model.file)
      const server: Server = { binary, model: modelPath, gpu: build.gpu }
      await stop($)
      await $.store.set('server', server)
      await $.store.delete('url')
      $.ui.status('starting the server')
      const up = await start($, server)
      $.ui.toast(up ? `Metka is installed and running (${model.file}, ${build.gpu ? 'GPU' : 'CPU'}).` : `Metka is installed, but its server didn't come up; see ${dir}/server.log.`)
    } catch (e) {
      $.ui.toast(`Metka setup failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      $.ui.status(undefined)
    }
  })()
  return `Installing ${model.file} and llama.cpp ${LLAMA} (${build.label}) into ~/.claude/metka. The status line shows the download; labels start once it's done.`
}

async function own($: any) {
  const answer = await $.ui.ask('The server\'s address? Pick one, or type yours below.',
    { header: 'Server', options: ['http://127.0.0.1:8080', 'http://127.0.0.1:11434'] })
  const url = answer.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(url)) return `"${url}" is not an address (http://host:port).`
  const found = await probe($, url)
  if (!found.ok) return `Nothing answered at ${url} (neither /health nor /v1/models). Is the server running, and reachable from here?`
  await $.store.set('url', url)
  return `Labels now come from ${url}${found.model ? ` (${found.model})` : ''}.`
}

async function settings($: any, options: any) {
  const now = await minConfidence($, options)
  const keep = `Keep ${now}`
  const cut = await $.ui.ask(`Least confidence: a label whose least likely word is less probable than this is cut back to its confident start, or the row keeps the command. Now ${now}; 0 shows every label. Pick one or type a number below.`,
    { header: 'Confidence', options: [keep, ...['0.15', '0'].filter(v => Number(v) !== now)] })
  if (cut !== keep) {
    const value = Number(cut)
    if (!Number.isFinite(value) || value < 0 || value > 1) return `"${cut}" is not a number from 0 to 1; nothing changed.`
    await $.store.set('minConfidence', value)
  }
  const skip = await $.ui.ask("Ask Claude to leave out Bash's description field, which the label replaces? It saves Claude writing one for every command, and reaches Claude with the next conversation or compaction.",
    { header: 'Descriptions', options: ['Yes, leave it out', 'No, keep descriptions'] })
  await $.store.set('skipDescription', skip.startsWith('Yes'))
  return `Least confidence ${await minConfidence($, options)}; Claude ${(await skipDescription($, options)) ? 'leaves out' : 'keeps'} Bash descriptions.`
}

async function status($: any, options: any) {
  const url = await urlOf($, options)
  const found = await probe($, url)
  const server = (await $.store.get('server')) as Server | undefined
  return [
    `Labels come from ${url}: ${found.ok ? `up${found.model ? ` (${found.model})` : ''}` : 'not answering'}.`,
    server && url === DEFAULT_URL ? `Installed here: ${server.model.split('/').pop()} on the ${server.gpu ? 'GPU' : 'CPU'}, started by the first session that needs it. /metka stop stops it.` : '',
    `Least confidence ${await minConfidence($, options)}; Claude ${(await skipDescription($, options)) ? 'leaves out' : 'keeps'} Bash descriptions.`,
  ].filter(Boolean).join('\n')
}

// /metka asks what to do; /metka status and /metka stop answer at once.
export async function metka($: any, options: any, args = '') {
  const word = args.trim().toLowerCase()
  if (word === 'stop') return stop($)
  if (word === 'status') return status($, options)
  const choices = ['Install it here', 'Use my own server', 'Settings', 'Status']
  let pick: string
  try {
    pick = await $.ui.ask('Metka writes the labels. Where should it run?', { header: 'Metka', options: choices })
  } catch {
    return status($, options)
  }
  try {
    if (pick === choices[0]) return await install($)
    if (pick === choices[1]) return await own($)
    if (pick === choices[2]) return await settings($, options)
    return await status($, options)
  } catch {
    return 'Nothing changed.'
  }
}
