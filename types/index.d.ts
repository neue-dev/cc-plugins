declare module 'claude-code' {
  interface PluginState {
    'cc-prompt-queue': {
      queue: string[]
      isPaused: boolean
      isBusy: boolean
      held: string[] | null
    }
  }
}
