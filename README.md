# Creator OS plugin for Claude Code

One plugin that bundles everything Creator OS offers inside Claude Code:

- **The connector**: the hosted MCP server at `https://mcp.creatoros.ca/mcp` (post, schedule, analytics, inbox, ads, Skool, blog, links).
- **Skills**: the campaign builders (Meta, TikTok, Google, LinkedIn) and Agent Posts.
- **A mod** (needs Claude Code 2.1.287 or later): a setup band above the prompt and a `/creatoros` pane with Overview, Scheduled and Inbox tabs.

## Install

In Claude Code:

```
/plugin marketplace add kevinbadi/creatoros-claude-plugin
/plugin install creatoros@creatoros
```

From a shell the same two steps are `claude plugin marketplace add kevinbadi/creatoros-claude-plugin` and `claude plugin install creatoros@creatoros`.

Then paste your API key (`cos_live_...`, from https://www.creatoros.ca/app/settings) when asked, or later with `/plugin configure creatoros@creatoros`. The key is stored in your system's secure storage, never in a repo file, and is used for both the connector and the mod. `/plugin` should then show `1 mod active · creatoros`.

To try it from a checkout without installing: `claude --plugin-dir plugin/creatoros`.

## What you get

| | |
| :- | :- |
| Band above the prompt | "Creator OS isn't connected" until the key works, then the workspace, account count and a Run onboarding button (it fills the prompt, you send it). |
| `/creatoros` | A pane with Overview, Scheduled and Inbox tabs, and Refresh. |
| `/cos-stats` | One line: accounts, followers, scheduled posts, comments. No Claude turn. |
| `/cos-health` | Accounts that need reconnecting. No Claude turn. |
| Publish guard | Before a Creator OS tool publishes, spends or deletes, you get a Proceed / Cancel question that says what will happen (networks, caption, schedule, ad budget and dates, and whether a validate_only check ran). Cancel refuses the call. |
| Status line | `Creator OS · <workspace> · <n> accounts`. |

Where nothing draws (`claude -p`, the VS Code chat panel, cloud sessions) the commands answer as text and no pane opens. With nobody to ask, the guard steps aside and the session's own permissions decide.

A read-only key shows as "read-only key", and the guard refuses writes with it up front.

## What the mod does, and doesn't

`claude plugin validate plugin/creatoros` lists every event it hooks and every call it makes. In short:

- It reads the public `/v1` API (`/v1/me`, `/v1/accounts`, `/v1/accounts/health`, `/v1/accounts/followers`, `/v1/posts`, `/v1/inbox/comments`) with your key. Read only.
- "Run onboarding" fills the prompt box. You press Enter yourself.
- The guard only ever adds a question. Proceed hands the call to the normal permission flow; it never approves anything for you.
- It never reads environment variables or settings files and never submits a prompt.

## Layout

```
plugin/
  .claude-plugin/marketplace.json    marketplace "creatoros"
  creatoros/
    .claude-plugin/plugin.json       manifest + the api_key option
    .mcp.json                        the hosted connector
    skills/                          copied by scripts/sync-skills.mjs, do not edit here
    hooks/register.tsx               the mod
    hooks/register.test.ts           its tests
    types/index.d.ts                 the mod's state contract
    tsconfig.json
  scripts/sync-skills.mjs
```

## Working on it

The public repo `kevinbadi/creatoros-claude-plugin` is published from the Creator OS monorepo, where `scripts/` and the skills' sources live. Changes are made there.

```bash
node plugin/scripts/sync-skills.mjs      # after changing api/skills/* or web/skill
claude plugin validate plugin/creatoros
claude plugin test plugin/creatoros
npx tsc -p plugin/creatoros           # after one load, which lays the types in .claude-plugin/types
```

Skills are edited at their source (`api/skills/<name>/SKILL.md`, `web/skill/`), then synced. The mod API is early access: check each call against the `claude-code.d.ts` the `plugin-authoring` skill writes, not memory. To ship an update, bump `version` in `plugin.json` and run `node plugin/scripts/publish.mjs` (add `--dry-run` to preview). It syncs the skills, validates, tests, and pushes this folder to the public marketplace repo `kevinbadi/creatoros-claude-plugin`; the source of truth stays here.
