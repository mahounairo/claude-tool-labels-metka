// One call's label: the running one while the command runs, then its past tense or failure form.
export type Label = {
  text: string
  done: boolean
  unsure?: boolean
  error?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    metka: { labels: Shaped<Record<string, Label>> }
  }
}
