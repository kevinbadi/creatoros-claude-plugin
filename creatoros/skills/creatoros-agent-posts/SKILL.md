---
name: creatoros-agent-posts
description: Creator OS Agent Posts. Drop a finished vertical video and Creator OS transcribes it, pulls the "comment X" keyword, writes platform captions and hashtags, paints a branded 9:16 cover from your reference photos, books the next free slot, schedules it to every connected social, and arms the comment-to-DM funnel. Use when the user wants to post a video, schedule agent posts, check the cut sheet, or tune their brand kit (logos, colours, fonts, voice, posting hours).
---

# Creator OS Agent Posts

Everything runs on Creator OS servers. This skill is a thin, scriptable client:
you get full control over captions, keywords, platforms, links and the brand
kit without running any AI locally.

## FIRST RUN: the Creator OS API key

If `CREATOR_OS_API_KEY` is missing from `.env.local`, say this before anything else:

> To run Agent Posts you need your Creator OS API key. Get it at
> **https://www.creatoros.ca/app/settings** (API key). It is the key for the
> workspace you want to post from. Paste it into `.env.local` as
> `CREATOR_OS_API_KEY=...` and run `node scripts/check-setup.mjs`.

Then run `node --env-file=.env.local scripts/check-setup.mjs`. It verifies the
key, prints the workspace, the connected video platforms, the next open slot,
and whether covers are possible (reference photos present). Do not try to post
before it passes.

## Commands

```bash
node --env-file=.env.local scripts/check-setup.mjs
node --env-file=.env.local scripts/post.mjs --video ./clip.mp4 [options] --wait
node --env-file=.env.local scripts/list.mjs                     # the cut sheet
node --env-file=.env.local scripts/brand-kit.mjs get > kit.json # read the kit
node --env-file=.env.local scripts/brand-kit.mjs set kit.json   # write it back
```

### post.mjs options

| flag | what it does |
|---|---|
| `--video <file or https url>` | required. A file is uploaded first (MP4, MOV, WebM). |
| `--caption "<text>"` | your Instagram caption. Creator OS keeps it word for word and only adapts the per-platform versions. Omit to let the agent write it from the transcript. |
| `--title "<text>"` | YouTube title (100 chars). Omit to let the agent write one. |
| `--keyword WORD` | the comment-to-DM keyword. Omit and it is pulled from the spoken "comment the word X". |
| `--link <url>` | the resource the DM delivers. Turns the comment-to-DM funnel on. |
| `--dm "<text>"` | first line of the DM (the link and a follow ask are appended). |
| `--platforms instagram,tiktok,youtube` | subset of connected platforms. Default is all of them. |
| `--wait` | poll until scheduled (or failed) and print the result. |

Platforms: instagram, tiktok, youtube, twitter, threads, linkedin, facebook.

## How to take customization further

- **Own the caption.** Write it yourself (or generate it with your own prompt)
  and pass `--caption`. The agent never rewrites a creator-written caption.
- **Own the keyword and DM.** `--keyword` + `--dm` give you the exact funnel copy.
- **Own the brand.** `brand-kit.mjs get` returns JSON with `logos`, `photos`,
  `colors`, `typography`, `coverStyle` (bold | clean | minimal | editorial),
  `coverNotes`, `voiceNotes`, `postingHours` (0 to 23, up to 8), `timezone`,
  `defaultResourceUrl`, `coverEnabled`. Edit and `set` it back. `voiceNotes`
  is read before every caption; `coverNotes` before every cover.
- **Batch.** Loop `post.mjs` over a folder of clips; each takes the next free
  slot on the posting grid, so a week of content books itself.

## Rules

- Never guess a keyword. If the video has no spoken CTA and the user gave no
  `--keyword`, ask, or post without `--link` (no funnel).
- Dates are shown in the workspace timezone from the brand kit.
- Do not upload the same file twice; Creator OS rejects duplicates per workspace.
- No em dashes in captions (house style; the server strips them anyway).

## Layout

```
creatoros-agent-posts/
  SKILL.md
  scripts/lib.mjs          API client (base URL, key, whoami, upload)
  scripts/check-setup.mjs  first-run check
  scripts/post.mjs         upload + queue + optional wait
  scripts/list.mjs         cut sheet
  scripts/brand-kit.mjs    get / set the brand kit
```
