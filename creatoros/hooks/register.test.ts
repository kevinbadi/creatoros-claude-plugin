import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'creatoros',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const
const PANE = {
  plugin: 'creatoros',
  component: 'Pane',
  requestId: 'creatoros',
  props: {
    title: 'Creator OS',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const
const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const ME = { workspace: { id: 'w1', name: 'Kev Builds Apps', ready: true }, plan: { active: true }, scope: 'read_write' }
const ROUTES: Record<string, unknown> = {
  '/v1/accounts': {
    accounts: [
      { id: 'acc_1', platform: 'instagram', username: 'kev' },
      { id: 'acc_2', platform: 'tiktok', username: 'kev', needsReconnection: true },
    ],
  },
  '/v1/accounts/health': { accounts: [{ id: 'acc_1', status: 'healthy' }] },
  '/v1/accounts/followers': { accounts: [{ id: 'acc_1', currentFollowers: 1200 }, { id: 'acc_2', currentFollowers: 300 }] },
  '/v1/posts': { posts: [{ id: 'post_1', status: 'scheduled', scheduledFor: '2026-10-05T19:00:00Z', content: 'Launch day', platforms: [{ platform: 'instagram' }] }] },
  '/v1/inbox/comments': { data: [{ id: 'post_9', commentCount: 4 }] },
}

// The engine's side of everything the mod calls, with the API answered from
// ROUTES (or one status for every path). Returns what the mod asked for.
function world(on: On, status = 200, surfaces: readonly ('terminal' | 'desktop' | 'vscode')[] = ['terminal'], me: Record<string, unknown> = {}) {
  const seen = { urls: [] as string[], auth: [] as string[], fills: [] as string[], submits: 0, logs: [] as string[], status: [] as (string | undefined)[], opens: 0 }
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text)

    return { value: undefined }
  })
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    seen.opens += 1

    return { value: { isPlaced: true } }
  })
  // What the engine draws when the mod passes: nothing of its own.
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, null) as RenderElement)
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', (_$, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e, next) => {
    seen.submits += 1
    return next(e)
  })
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    seen.urls.push(url.host + url.pathname)
    seen.auth.push(e.init?.headers?.authorization ?? '')
    const body = status === 200 ? (url.pathname === '/v1/me' ? { ...ME, ...me } : ROUTES[url.pathname]) : { error: { code: 'x', message: 'UpstreamError: stack trace at line 1' } }
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body ?? {}) } }
  })
  return seen
}

test('with no key the band says it is not connected and explains how', async ($, on) => {
  const seen = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: "Creator OS isn't connected" })).toBeDefined()
    await ui.press({ key: 'connect' })
    await ui.unmount()
  }
  expect(seen.logs[0]).toContain('https://www.creatoros.ca/app/settings')
  expect(seen.urls).toHaveLength(0)
})

test('connected: the band names the workspace and onboarding only fills the prompt', { options: { api_key: 'cos_live_test' } }, async ($, on) => {
  const seen = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Creator OS: Kev Builds Apps, 2 connected accounts' })).toBeDefined()
    await ui.press({ key: 'onboard' })
    await ui.unmount()
  }
  expect(seen.fills).toHaveLength(2)
  expect(seen.fills[0]).toContain('Onboard me on Creator OS')
  expect(seen.submits).toBe(0)
  expect(seen.urls.every(u => u.startsWith('mcp.creatoros.ca/v1/'))).toBe(true)
  expect(seen.auth.every(a => a === 'Bearer cos_live_test')).toBe(true)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'onboard' })).toBeUndefined()
})

test('a rejected key reads as one plain line, never the upstream body', { options: { api_key: 'cos_live_bad' } }, async ($, on) => {
  world(on, 401)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.find({ type: 'Text' }))?.text ?? ''
  expect(text).toBe("Creator OS isn't connected: That API key was not accepted. Check it in /plugin.")
  expect(text).not.toContain('stack trace')
})

test('/creatoros opens the pane and its tabs show accounts, scheduled posts and the inbox', { options: { api_key: 'cos_live_test' } }, async ($, on) => {
  world(on)
  await $.session.start(START)
  const ran = await $.command.run({ command: 'creatoros', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(ran.text).toBe('Creator OS pane opened.')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: '1,500 followers in total' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tiktok @kev {2}reconnect/ })).toBeDefined()
    await ui.press({ key: 'tab-scheduled' })
    expect(await ui.find({ type: 'Text', text: /2026-10-05 19:00 UTC {2}instagram {2}Launch day/ })).toBeDefined()
    await ui.press({ key: 'tab-inbox' })
    expect(await ui.find({ type: 'Text', text: /4 comments across 1 post\./ })).toBeDefined()
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }
})

test('the pane degrades to readable text when the plan has lapsed', { options: { api_key: 'cos_live_test' } }, async ($, on) => {
  world(on, 402)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: 'An active Creator OS plan is needed. See creatoros.ca/subscribe.' })).toBeDefined()
})

test('/cos-stats and /cos-health answer as text, and the status line names the workspace', { options: { api_key: 'cos_live_test' } }, async ($, on) => {
  const seen = world(on)
  await $.session.start(START)
  const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect((await run('cos-stats')).text).toBe('Creator OS: Kev Builds Apps, 2 accounts, 1,500 followers, 1 scheduled, 4 comments on 1 post')
  expect((await run('cos-health')).text).toBe('Creator OS: 1 of 2 accounts need attention: tiktok @kev (reconnect). Reconnect at creatoros.ca/app/connect.')
  expect(seen.status).toContain('Creator OS · Kev Builds Apps · 2 accounts')
})

test('where nothing draws, /creatoros answers as text and opens no pane', { options: { api_key: 'cos_live_test' } }, async ($, on) => {
  const seen = world(on, 200, ['vscode'])
  await $.session.start({ ...START, surface: 'vscode' })
  const ran = await $.command.run({ command: 'creatoros', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(ran.text).toContain('Creator OS: Kev Builds Apps, 2 accounts')
  expect(seen.opens).toBe(0)
})

const POST = { tool: 'mcp__plugin_creatoros_creatoros__create_post' as const, tool_use_id: 't1', platforms: ['instagram', 'tiktok'], content: 'Launch day', schedule_at: '2026-10-05T19:00:00Z' }

// The engine's side of a held call: the question the mod asks, and the tool itself.
function tools(on: On, answer: string) {
  const seen = { questions: [] as string[], ran: [] as string[] }
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      const asked = e.questions[0]?.question ?? ''
      seen.questions.push(asked)

      return { result: { questions: e.questions, answers: { [asked]: answer } } }
    }
    seen.ran.push(String(e.tool))

    return { result: { ok: true } }
  })
  return seen
}

test('the publish guard denies on Cancel and passes through on Proceed', { options: { api_key: 'cos_live_test' } }, async ($, on) => {
  world(on)
  const seen = tools(on, 'Cancel')
  await $.session.start(START)
  const cancelled = await $.tool.call(POST)
  expect(cancelled.deny).toBe('Cancelled in Creator OS')
  expect(seen.ran).toHaveLength(0)
  expect(seen.questions[0]).toContain('schedule for 2026-10-05T19:00:00Z on instagram, tiktok')
  expect(seen.questions[0]).toContain('Caption: "Launch day"')
})

test('Proceed runs the call, reads pass untouched, and an unvalidated ad says so', { options: { api_key: 'cos_live_test' } }, async ($, on) => {
  world(on)
  const seen = tools(on, 'Proceed')
  await $.session.start(START)
  expect((await $.tool.call(POST)).deny).toBeUndefined()
  await $.tool.call({ tool: 'mcp__plugin_creatoros_creatoros__list_posts', tool_use_id: 't2' })
  await $.tool.call({ tool: 'mcp__other__create_post', tool_use_id: 't3' })
  expect(seen.questions).toHaveLength(1)

  const ad = { tool: 'mcp__claude_ai_mcp_creatoros_ca__ads_create_ad' as const, budget_amount: 25, budget_type: 'daily', start_date: '2026-10-06' }
  await $.tool.call({ ...ad, tool_use_id: 't4' })
  expect(seen.questions[1]).toContain('Budget: 25 daily')
  expect(seen.questions[1]).toContain('No validate_only check was run first.')
  await $.tool.call({ ...ad, tool_use_id: 't5', validate_only: true })
  await $.tool.call({ ...ad, tool_use_id: 't6' })
  expect(seen.questions).toHaveLength(3)
  expect(seen.questions[2]).not.toContain('validate_only')
  expect(seen.ran).toHaveLength(6)
})

test('a read-only key is named and its writes are refused without asking', { options: { api_key: 'cos_live_read' } }, async ($, on) => {
  const seen = world(on, 200, ['terminal'], { scope: 'read' })
  const asked = tools(on, 'Proceed')
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /\(read-only key\)/ })).toBeDefined()
    await ui.unmount()
  }
  expect(seen.status).toContain('Creator OS · Kev Builds Apps · 2 accounts · read-only key')
  expect((await $.tool.call(POST)).deny).toContain('read-only key')
  expect(asked.questions).toHaveLength(0)
})
