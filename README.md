# Metka for Claude Code

Short labels for Claude Code's Bash commands, written by [Metka](https://huggingface.co/mahounairo/metka-1.7b-gguf), a small model that runs locally next to Claude on whatever is left over: a CPU, a laptop, or a little spare VRAM.

The Bash row shows the command greyed out while Metka's label writes itself over it. When the command ends, the label turns into its past tense, or into "Failed to ..." with a red dot. ctrl+o shows the full command as usual.

By default the plugin also asks Claude to leave out Bash's `description` field, since Metka's label takes its place. That saves Claude writing a description for every command. To keep Claude's own descriptions, turn it off in `/metka` → **Settings**.

Claude reads its tool instructions once, at the start of a conversation, and again only after a compaction. So in a conversation that was already open when you installed the plugin (or changed this setting), Claude keeps writing descriptions until the next compaction or a new conversation. The labels themselves work right away.

## Install

At the prompt of a Claude Code session:

```
/plugin install metka --marketplace mahounairo/claude-tool-labels-metka
```

Answer `y` to add the marketplace, then pick a scope.

Then run `/metka` and pick **Install it here**. It asks which model and, on Linux, whether to run it on the CPU or the GPU, then downloads a llama.cpp release tested with Metka and the model into `~/.claude/metka`, and starts the server (its log is `~/.claude/metka/server.log`). The status line shows the download. From then on, the first Claude Code session that needs the server starts it in the background, and every session shares it. It keeps running after Claude Code exits. `/metka` stops it until the next session starts it again; to keep it off, point the plugin at another server or uninstall it.

| Model | Size | |
|---|---|---|
| [metka-1.7b-gguf](https://huggingface.co/mahounairo/metka-1.7b-gguf) | 1.8 GB | the better labels |
| [metka-0.6b-gguf](https://huggingface.co/mahounairo/metka-0.6b-gguf) | 640 MB | for laptops and older CPUs |

The install works on Linux (x64 and arm64) and macOS. Elsewhere, run a server yourself (below).

`/metka` also has the settings and the status, and switches between the installed server and one of your own. `/metka status` and `/metka stop` work without the questions.

## Your own server

Run a Metka model with [llama.cpp](https://github.com/ggml-org/llama.cpp):

```
llama-server -m metka-1.7b-Q8_0.gguf -c 4096 --parallel 2 --port 8080
```

then run `/metka`, pick **Use my own server**, and give its address. Any other server with the OpenAI completions API (`/v1/completions`) works too, as long as it passes the prompt through without a chat template. With Ollama, put `TEMPLATE "{{ .Prompt }}"` in the Modelfile.

The plugin uses `curl` to stream labels as they are written, so curl has to be on the PATH (it is on macOS and most Linux systems).

## Settings

In `/metka` → **Settings**:

| Setting | Default | What it does |
|---|---|---|
| Least confidence | `0.15` | A label whose least likely word is less probable than this is cut back to its confident start, or the row keeps the command; `0` turns it off |
| Descriptions | leave out | Whether Claude is asked to leave out Bash's `description` field (from the next conversation or compaction) |

If the server doesn't answer, the plugin says so once a session and leaves the rows as they are.

Each Bash command's text is sent to the label server. With the installed server, or any on your own machine, it stays local; a server elsewhere receives your commands.

## License

Apache 2.0. The Metka models are Apache 2.0 too; see their model cards for training data and credits.
