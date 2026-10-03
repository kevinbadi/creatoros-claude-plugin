export type Connection =
  | { status: 'checking' }
  | { status: 'no_key' }
  | { status: 'error'; message: string }
  | { status: 'connected'; workspace: string; accounts: number; isReadOnly: boolean }

export type Tab = 'overview' | 'scheduled' | 'inbox'

export type AccountRow = {
  id: string
  platform: string
  handle: string
  health: string
  followers: number | null
}

export type PostRow = { id: string; when: string; platforms: string; text: string }

export type Section<T> = { ok: true; value: T } | { ok: false; message: string }

export type PaneData = {
  fetchedAt: number
  overview: Section<{ workspace: string; accounts: AccountRow[]; followers: number | null }>
  scheduled: Section<PostRow[]>
  inbox: Section<{ posts: number; comments: number }>
}

declare module 'claude-code' {
  interface PluginState {
    creatoros: {
      connection: Connection
      isBandHidden: boolean
      tab: Tab
      data: PaneData | null
      isLoading: boolean
      /** Ads tools whose validate_only check ran this session. */
      validated: string[]
    }
  }
}
