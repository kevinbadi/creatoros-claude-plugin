import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountRow, Connection, PaneData, PostRow, Section, Tab } from '../types'

// Creator OS mod. Read-only: it calls the public /v1 API with the key the
// person saved in the plugin's config, draws what it finds, and fills (never
// submits) the prompt. It approves no tool call and reads no env or settings.

const API = 'https://mcp.creatoros.ca'
const PANE = 'creatoros'
const SETTINGS_URL = 'https://www.creatoros.ca/app/settings'
const ONBOARDING_PROMPT =
  'Onboard me on Creator OS: list my connected accounts and their health, show what is scheduled, summarize my recent results, and suggest what to do first. Ask before posting or changing anything.'
const HOW_TO_CONNECT = `Creator OS: copy your API key (cos_live_...) from ${SETTINGS_URL}, then run /plugin configure creatoros@creatoros and paste it as the API key.`

const connection = atom({ plugin: 'creatoros', key: 'connection' } as const, { status: 'checking' })
const isBandHidden = atom({ plugin: 'creatoros', key: 'isBandHidden' } as const, false)
const tab = atom({ plugin: 'creatoros', key: 'tab' } as const, 'overview')
const data = atom({ plugin: 'creatoros', key: 'data' } as const, null)
const isLoading = atom({ plugin: 'creatoros', key: 'isLoading' } as const, false)
const validated = atom({ plugin: 'creatoros', key: 'validated' } as const, [])

type Json = Record<string, any>
type ApiResult = { ok: true; body: Json } | { ok: false; status: number; message: string }

// One readable line per failure, never the raw body or a stack trace.
function failure(status: number, body: Json | null): string {
  if (status === 401) return 'That API key was not accepted. Check it in /plugin.'
  if (status === 402) return 'An active Creator OS plan is needed. See creatoros.ca/subscribe.'
  if (status === 403) return String(body?.error?.code ?? body?.error ?? '') === 'insufficient_scope' ? 'read-only key' : 'This key is not allowed to read that.'
  if (status === 429) return 'Too many requests. Try again in a minute.'
  const code = String(body?.error?.code ?? body?.error ?? '')
  if (code === 'needs_setup') return 'Finish setting up your workspace at creatoros.ca/setup.'
  if (status === 0) return 'Could not reach Creator OS. Check your connection.'
  return `Creator OS could not answer (${status}). Try Refresh.`
}

async function api($: EngineInterface, key: string, path: string): Promise<ApiResult> {
  try {
    const res = await $.http.fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    })
    let body: Json | null = null
    try {
      body = JSON.parse(res.text)
    } catch {
      body = null
    }
    if (!res.ok) return { ok: false, status: res.status, message: failure(res.status, body) }
    if (body?.needs_setup === true) return { ok: false, status: res.status, message: failure(200, { error: 'needs_setup' }) }
    return { ok: true, body: body ?? {} }
  } catch {
    return { ok: false, status: 0, message: failure(0, null) }
  }
}

const list = (v: unknown): Json[] => (Array.isArray(v) ? v : [])
const idOf = (a: Json): string => String(a.id ?? a._id ?? a.accountId ?? '')

function healthOf(h: Json | undefined, a: Json): string {
  if (a.needsReconnection === true || h?.needsReconnect === true || h?.needsReconnection === true) return 'reconnect'
  const status = h?.status ?? h?.health
  if (typeof status === 'string' && status) return status
  if (a.isActive === false) return 'inactive'
  return 'ok'
}

function when(iso: unknown): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return 'no date'
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

async function loadOverview($: EngineInterface, key: string): Promise<PaneData['overview']> {
  const [me, accounts, health, followers] = await Promise.all([
    api($, key, '/v1/me'),
    api($, key, '/v1/accounts'),
    api($, key, '/v1/accounts/health'),
    api($, key, '/v1/accounts/followers'),
  ])
  if (!me.ok) return { ok: false, message: me.message }
  if (!accounts.ok) return { ok: false, message: accounts.message }
  // Health and follower counts are extras: without them the accounts still list.
  const healthById = new Map(list(health.ok ? health.body.accounts : []).map(h => [idOf(h), h]))
  const followerRows = list(followers.ok ? followers.body.accounts : [])
  const followersById = new Map(followerRows.map(f => [idOf(f), f]))
  const rows: AccountRow[] = list(accounts.body.accounts).map(a => {
    const count = followersById.get(idOf(a))?.currentFollowers
    return {
      id: idOf(a),
      platform: String(a.platform ?? 'account'),
      handle: String(a.username ?? a.displayName ?? ''),
      health: healthOf(healthById.get(idOf(a)), a),
      followers: typeof count === 'number' ? count : null,
    }
  })
  const total = followers.ok
    ? followerRows.reduce((sum, f) => sum + (typeof f.currentFollowers === 'number' ? f.currentFollowers : 0), 0)
    : null
  return { ok: true, value: { workspace: String(me.body.workspace?.name ?? 'Workspace'), accounts: rows, followers: total } }
}

async function loadScheduled($: EngineInterface, key: string): Promise<Section<PostRow[]>> {
  const res = await api($, key, '/v1/posts?status=scheduled&limit=20')
  if (!res.ok) return { ok: false, message: res.message }
  const posts = list(res.body.posts ?? res.body.data)
    .filter(p => p.status === undefined || p.status === 'scheduled')
    .sort((a, b) => String(a.scheduledFor ?? '').localeCompare(String(b.scheduledFor ?? '')))
  return {
    ok: true,
    value: posts.map(p => ({
      id: idOf(p),
      when: when(p.scheduledFor),
      platforms: list(p.platforms).map(t => String(t.platform ?? '')).filter(Boolean).join(', '),
      text: String(p.content ?? p.title ?? '').replace(/\s+/g, ' ').trim(),
    })),
  }
}

async function loadInbox($: EngineInterface, key: string): Promise<PaneData['inbox']> {
  const res = await api($, key, '/v1/inbox/comments')
  if (!res.ok) return { ok: false, message: res.message }
  const posts = list(res.body.data ?? res.body.posts)
  const comments = posts.reduce((sum, p) => sum + (Number(p.commentCount ?? p.comment_count ?? p.commentsCount) || 0), 0)
  return { ok: true, value: { posts: posts.length, comments } }
}

const clip = (text: string, columns: number): string =>
  text.length <= columns ? text : text.slice(0, Math.max(1, columns - 1)) + '…'

async function check($: EngineInterface, key: string): Promise<void> {
  if (!key) {
    await update($, connection, (): Connection => ({ status: 'no_key' }))
    return
  }
  const [me, accounts] = await Promise.all([api($, key, '/v1/me'), api($, key, '/v1/accounts')])
  const next: Connection = !me.ok
    ? { status: 'error', message: me.message }
    : me.body.workspace?.ready === false || me.body.workspace === null
      ? { status: 'error', message: failure(200, { error: 'needs_setup' }) }
      : {
          status: 'connected',
          workspace: String(me.body.workspace?.name ?? 'Workspace'),
          accounts: accounts.ok ? list(accounts.body.accounts).length : 0,
          isReadOnly: me.body.scope === 'read',
        }
  await update($, connection, () => next)
  $.ui.status(next.status === 'connected' ? statusLine(next) : undefined)
}

async function refresh($: EngineInterface, key: string): Promise<void> {
  if (!key) return
  await update($, isLoading, () => true)
  try {
    const [overview, scheduled, inbox] = await Promise.all([loadOverview($, key), loadScheduled($, key), loadInbox($, key)])
    const fetchedAt = await $.clock.now()
    await update($, data, (): PaneData => ({ fetchedAt, overview, scheduled, inbox }))
  } finally {
    await update($, isLoading, () => false)
  }
}

type Connected = Extract<Connection, { status: 'connected' }>

const statusLine = (c: Connected): string =>
  `Creator OS · ${c.workspace} · ${c.accounts} ${c.accounts === 1 ? 'account' : 'accounts'}${c.isReadOnly ? ' · read-only key' : ''}`

// Panes and bands draw on the terminal and the desktop app only; anywhere
// else (claude -p, the VS Code chat panel, cloud) a command answers as text.
async function canDraw($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).some(s => s === 'terminal' || s === 'desktop')
}

const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

async function statsText($: EngineInterface, key: string): Promise<string> {
  if (!key) return HOW_TO_CONNECT
  const me = await api($, key, '/v1/me')
  if (!me.ok) return `Creator OS: ${me.message}`
  const [accounts, followers, scheduled, inbox] = await Promise.all([
    api($, key, '/v1/accounts'),
    api($, key, '/v1/accounts/followers'),
    loadScheduled($, key),
    loadInbox($, key),
  ])
  const parts = [String(me.body.workspace?.name ?? 'Workspace')]
  if (accounts.ok) parts.push(plural(list(accounts.body.accounts).length, 'account'))
  if (followers.ok) {
    const total = list(followers.body.accounts).reduce((sum, f) => sum + (typeof f.currentFollowers === 'number' ? f.currentFollowers : 0), 0)
    parts.push(`${total.toLocaleString('en-US')} followers`)
  }
  if (scheduled.ok) parts.push(`${scheduled.value.length} scheduled`)
  if (inbox.ok) parts.push(`${plural(inbox.value.comments, 'comment')} on ${plural(inbox.value.posts, 'post')}`)
  if (me.body.scope === 'read') parts.push('read-only key')
  return `Creator OS: ${parts.join(', ')}`
}

async function healthText($: EngineInterface, key: string): Promise<string> {
  if (!key) return HOW_TO_CONNECT
  const overview = await loadOverview($, key)
  if (!overview.ok) return `Creator OS: ${overview.message}`
  const bad = overview.value.accounts.filter(a => a.health !== 'ok' && a.health !== 'healthy')
  if (overview.value.accounts.length === 0) return 'Creator OS: no accounts connected yet. Connect one at creatoros.ca/app/connect.'
  if (bad.length === 0) return `Creator OS: all ${overview.value.accounts.length} accounts are healthy.`
  return `Creator OS: ${bad.length} of ${overview.value.accounts.length} accounts need attention: ${bad
    .map(a => `${a.platform}${a.handle ? ' @' + a.handle : ''} (${a.health})`)
    .join(', ')}. Reconnect at creatoros.ca/app/connect.`
}

// ── Publish guard ────────────────────────────────────────────────────────
// The Creator OS tools that publish, spend or delete. Matched by the tool's
// own name on any Creator OS MCP server (this plugin's or the claude.ai
// connector), so both are held the same way.
const GUARDED = new Set([
  'create_post', 'update_post', 'delete_post', 'send_message', 'delete_comment', 'disconnect_account',
  'delete_automation', 'delete_webhook', 'blog_delete_article',
  'skool_create_post', 'skool_multi_post', 'skool_delete_post', 'skool_send_message', 'skool_block_user',
  'ads_create_ad', 'ads_boost_post', 'ads_update_budget', 'ads_set_status', 'ads_delete_ad', 'ads_duplicate', 'ads_request',
])
const NEEDS_VALIDATION = new Set(['ads_create_ad', 'ads_boost_post'])
const CANCELLED = 'Cancelled in Creator OS'

function guardedName(tool: string): string | null {
  const m = /^mcp__(.+)__([a-z0-9_]+)$/.exec(tool)
  if (!m || !/creatoros/i.test(m[1] ?? '')) return null
  const name = m[2] ?? ''
  return GUARDED.has(name) ? name : null
}

const say = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v ?? ''))
const excerpt = (v: unknown): string => {
  const text = String(v ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 80 ? text.slice(0, 79) + '…' : text
}

// What will happen, in the person's words, from the tool's own arguments.
function summarize(name: string, a: Json, hasValidated: boolean): string {
  const lines: string[] = []
  if (name === 'create_post' || name === 'update_post') {
    const timing = a.draft === true ? 'save a draft' : a.schedule_at ? `schedule for ${a.schedule_at}${a.timezone ? ' ' + a.timezone : ''}` : name === 'update_post' ? 'update a post' : 'publish now'
    lines.push(`Creator OS will ${timing}${a.platforms ? ' on ' + say(a.platforms) : ''}.`)
    if (a.content) lines.push(`Caption: "${excerpt(a.content)}"`)
  } else if (name.startsWith('ads_')) {
    const verb = { ads_create_ad: 'create an ad', ads_boost_post: 'boost a post', ads_update_budget: 'change an ad budget', ads_set_status: `set an ad to ${say(a.status) || 'a new status'}`, ads_delete_ad: 'delete an ad', ads_duplicate: 'duplicate an ad', ads_request: `send ${say(a.method) || 'a request'} ${say(a.path)}` }[name] ?? 'change your ads'
    lines.push(`Creator OS will ${verb}. This can spend real money.`)
    if (a.name) lines.push(`Name: ${excerpt(a.name)}`)
    if (a.budget_amount !== undefined) lines.push(`Budget: ${say(a.budget_amount)}${a.budget_type ? ' ' + say(a.budget_type) : ''}`)
    if (a.start_date || a.end_date) lines.push(`Dates: ${say(a.start_date) || 'now'} to ${say(a.end_date) || 'no end date'}`)
    if (NEEDS_VALIDATION.has(name) && !hasValidated) lines.push('No validate_only check was run first.')
  } else if (name === 'skool_create_post' || name === 'skool_multi_post') {
    lines.push(`Creator OS will post to Skool${a.community ? ' (' + say(a.community) + ')' : ''}.`)
    if (a.title || a.content) lines.push(`Post: "${excerpt(a.title ?? a.content)}"`)
  } else if (name === 'send_message' || name === 'skool_send_message') {
    lines.push('Creator OS will send a direct message.')
    if (a.message ?? a.content ?? a.text) lines.push(`Message: "${excerpt(a.message ?? a.content ?? a.text)}"`)
  } else {
    lines.push(`Creator OS will run ${name.replace(/_/g, ' ')}. This can not be undone.`)
  }
  return `${lines.join('\n')}\nProceed?`
}

export const register: Register = (on, options) => {
  const key = typeof options.api_key === 'string' ? options.api_key.trim() : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'creatoros', description: 'Open the Creator OS pane: accounts, scheduled posts, inbox' })
    await $.command.register({ name: 'cos-stats', description: 'Creator OS in one line: accounts, followers, scheduled, inbox', immediate: true })
    await $.command.register({ name: 'cos-health', description: 'Creator OS accounts that need reconnecting', immediate: true })
    void check($, key)

    return next(e)
  })

  on('command.run', { command: 'creatoros' }, async $ => {
    if (!key) return { text: HOW_TO_CONNECT }
    if (!(await canDraw($))) return { text: await statsText($, key) }
    const opened = await $.ui.open({ id: PANE, title: 'Creator OS' })
    void refresh($, key)

    return { text: opened.isPlaced === false ? 'Creator OS pane is waiting for room to open.' : 'Creator OS pane opened.' }
  })

  on('command.run', { command: 'cos-stats' }, async $ => ({ text: await statsText($, key) }))

  on('command.run', { command: 'cos-health' }, async $ => ({ text: await healthText($, key) }))

  // Holds a publish, spend or delete until the person answers. It only ever
  // adds a question: Proceed hands the call on to the usual permission flow.
  on('tool.call', async ($, e, next) => {
    const name = guardedName(String(e.tool))
    if (name === null) return next(e)
    const args = e as unknown as Json
    if (args.draft === true && name === 'create_post') return next(e)
    if (args.validate_only === true && NEEDS_VALIDATION.has(name)) {
      await update($, validated, names => (names.includes(name) ? names : [...names, name]))

      return next(e)
    }
    const state = await read($, connection)
    if (state.status === 'connected' && state.isReadOnly) {
      return { deny: `Creator OS: read-only key. Create a read and write key at ${SETTINGS_URL} to do this.` }
    }
    // Nobody to ask (claude -p, an SDK run): leave it to the session's own permissions.
    if ((await $.session.surfaces()).length === 0) return next(e)
    let answer = ''
    try {
      answer = await $.ui.ask(summarize(name, args, (await read($, validated)).includes(name)), { options: ['Proceed', 'Cancel'], header: 'Creator OS' })
    } catch {
      answer = 'Cancel'
    }

    return answer === 'Proceed' ? next(e) : { deny: CANCELLED }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, connection)
    if (e.props.hasSurvey || state.status === 'checking' || (await read($, isBandHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const hide = <Button key="hide" label="Hide" role="dismiss" onPress={() => update($, isBandHidden, () => true)} />

    if (state.status === 'connected') {
      const line = `Creator OS: ${state.workspace}, ${state.accounts} connected ${state.accounts === 1 ? 'account' : 'accounts'}${state.isReadOnly ? ' (read-only key)' : ''}`
      return (
        <Box gap={1}>
          <Text wrap="truncate-end">{clip(line, Math.max(20, e.props.bodyColumns - 30))}</Text>
          <Button
            key="onboard"
            label="Run onboarding"
            variant="primary"
            onPress={async () => {
              const filled = await $.prompt.fill({ text: ONBOARDING_PROMPT })
              if (!filled.isFilled) $.ui.toast('Clear the prompt box first, then press Run onboarding again.')
            }}
          />
          {hide}
        </Box>
      )
    }

    return (
      <Box gap={1}>
        <Text wrap="truncate-end">
          {state.status === 'no_key' ? "Creator OS isn't connected" : `Creator OS isn't connected: ${state.message}`}
        </Text>
        <Button key="connect" label="How to connect" variant="primary" onPress={() => $.ui.log(HOW_TO_CONNECT)} />
        {hide}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = Math.max(20, e.props.bodyColumns)
    const current = await read($, tab)
    const loaded = await read($, data)
    const loading = await read($, isLoading)
    const pick = (name: Tab, label: string, hotkey: string) => (
      <Button
        key={`tab-${name}`}
        label={label}
        hotkey={hotkey}
        variant={current === name ? 'primary' : 'secondary'}
        onPress={() => update($, tab, () => name)}
      />
    )

    let body
    if (!key) {
      body = <Text wrap="wrap">{HOW_TO_CONNECT}</Text>
    } else if (loaded === null) {
      body = <Text dimColor>{loading ? 'Loading…' : 'Press Refresh to load.'}</Text>
    } else if (current === 'overview') {
      const section = loaded.overview
      body = !section.ok ? (
        <Text wrap="wrap">{section.message}</Text>
      ) : (
        <Box key="body" flexDirection="column">
          <Text bold>{clip(section.value.workspace, columns)}</Text>
          <Text dimColor>
            {section.value.followers === null ? 'Follower totals unavailable' : `${section.value.followers.toLocaleString('en-US')} followers in total`}
          </Text>
          {section.value.accounts.length === 0 && <Text>No accounts connected yet. Connect one at creatoros.ca/app/connect.</Text>}
          {section.value.accounts.map(a => (
            <Text color={a.health === 'ok' || a.health === 'healthy' ? undefined : 'yellow'}>
              {clip(
                `${a.platform} ${a.handle ? '@' + a.handle : ''}  ${a.health}${a.followers === null ? '' : '  ' + a.followers.toLocaleString('en-US')}`,
                columns,
              )}
            </Text>
          ))}
        </Box>
      )
    } else if (current === 'scheduled') {
      const section = loaded.scheduled
      body = !section.ok ? (
        <Text wrap="wrap">{section.message}</Text>
      ) : (
        <Box key="body" flexDirection="column">
          {section.value.length === 0 && <Text>Nothing scheduled.</Text>}
          {section.value.map(p => (
            <Text>{clip(`${p.when}  ${p.platforms}  ${p.text}`, columns)}</Text>
          ))}
        </Box>
      )
    } else {
      const section = loaded.inbox
      body = !section.ok ? (
        <Text wrap="wrap">{section.message}</Text>
      ) : (
        <Text wrap="wrap">
          {section.value.posts === 0
            ? 'No comments waiting.'
            : `${section.value.comments} ${section.value.comments === 1 ? 'comment' : 'comments'} across ${section.value.posts} ${section.value.posts === 1 ? 'post' : 'posts'}. Ask Claude to "reply to my new comments" to work through them.`}
        </Text>
      )
    }

    return (
      <Box flexDirection="column" width={columns}>
        <Box gap={1} flexWrap="wrap">
          {pick('overview', 'Overview', '1')}
          {pick('scheduled', 'Scheduled', '2')}
          {pick('inbox', 'Inbox', '3')}
          <Button key="refresh" label={loading ? 'Refreshing…' : 'Refresh'} hotkey="r" onPress={() => refresh($, key)} />
        </Box>
        {body}
      </Box>
    )
  })
}
