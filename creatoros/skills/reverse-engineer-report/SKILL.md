---
name: reverse-engineer-report
description: Write the Reverse engineer marketing report yourself, on your own Claude, from the research the Creator OS server already did. Use when a reverse_engineer run is in status awaiting_agent (reverse_engineer_get shows agent_task): look at the studied winning videos' frame sheets, read their measurements and transcripts, reverse engineer the editing styles into SKILL.md files, map topics, hooks and comment-to-DM funnels, write 15+ video ideas for the business, and submit report.json with reverse_engineer_submit_report.
version: 1
---

# Reverse engineer report (written by your agent)

Creator OS runs Reverse engineer marketing on the owner's own AI. Without an Anthropic key in Smarty
Keys, the server does the free work (the TikTok search, the competitor channel scans, picking the
winners by how far they beat their account's median, downloading and measuring each one) and hands
the rest to you. You write the report; nothing is billed to anyone but you.

## 1. Get the task

`reverse_engineer_get` (or `GET /v1/reverse-engineer-marketing/{run_id}`) with status `awaiting_agent`
returns `agent_task`:

- `brief`: the business, its competitors, offers, searches and notes (what to research for).
- `prep`: what the server ran (searches, scans, which winners it picked and why).
- `scans`: one line per scan or search, with failures (a competitor it could not scan: look it up yourself if you can).
- `winners[]`: every studied winning video: `id` (w1, w2...), url, found_by (search / competitor_scan / example),
  author and followers, views, likes, outlier, posted_at, caption, `poster` and `sheets` (image URLs:
  hook frames, one frame per shot, a dense strip of the opening), `measurements` (cuts, shot lengths,
  visual events, faces, palette, loudness, pace) and `transcript` (word timings).
- `previous_summary` + `cycle` on a repeat check: say what is NEW in `changes`.

## 2. Study every winner

Open every sheet URL and LOOK at it, then read its measurements and transcript. Write down for each:
the hook (spoken words, on-screen text, what we see), the format, every recurring device (captions,
cards, zooms, B-roll, green screen, split, memes, screen recordings), the structure beat by beat with
timestamps, the CTA, and why it beat the account's median (be specific: the hook's promise, the payoff,
the pacing, the relatability, the controversy). For search winners say which seconds of the source they
used and why that moment works. Use the measured numbers, never guesses.

## Step 4. Reverse engineer the editing styles

Group the winners into editing styles (usually 2 to 5): winners that share a format and a set of
devices are one style. For each style write an editing skill (markdown, put it in the style's `skill_md`) an editor or an AI
agent can follow to make a new video in that style with the user's own footage:

```markdown
---
name: <slug>-edit
description: <what the style looks like and when to use it, as trigger criteria>
---
# <Style name>
Reverse engineered from: <winner urls>
## Numbers (measured)        table: shot median, cuts/min, visual events/min, face %, wpm, LUFS, length
## Structure                 the beat formula with timings (hook 0-3 s, setup, beats, payoff, CTA)
## Shots and layout          framing, talking head vs B-roll vs screen, layout, camera moves
## Devices                   one row per recurring element: what, how it enters, how long, when
## Text and captions         caption style, size, position, case, colours, on-screen headers
## Color and grade           palette (from the study), brightness, look
## Audio                     voice, music, SFX, loudness target
## Transitions               which, how often
## Make one                  numbered steps from raw footage to export
## Don'ts                    what breaks the style
```
Use the measured numbers from the studies (average across the style's winners), never guesses.
Name the closest Creator OS template in `closest_template` when one matches: split-animated-talking-head,
longform-animated-talking-head, fireship-style-short, fireship-style-edit, gadzhi-edit, nolan-edit,
split-animated-short, short-form-video-clone-edit, doodle-mascot-edit, moto-heartbreak-edit,
motion-styles, or `none`.

## Step 5. Topics, hooks, funnels

- **Topics:** what the winners are about, ranked by average outlier, each with its winner ids.
- **Hooks:** reusable hook patterns, each as a fill-in-the-blank template with the winner it came from.
- **Funnels:** how each competitor turns views into leads and sales. Evidence: captions and spoken CTAs
  ("comment X and I'll DM you"), link-in-bio pages (WebFetch them), lead magnets, landing pages,
  pricing, communities, ads you can see. For every comment-to-DM funnel, write the workflow the business
  can copy: the keyword, the DM message, what the link should be.

## Step 6. Video ideas for this business

At least 15 ideas, each adapted to the business's offer and audience (not a copy of a competitor's
video), each `based_on` specific winners and assigned a `style_id`. Each has 3 hook options, a full
script (spoken words, 20 to 60 s for short form), a shot list in that style, the caption, the CTA, and a
`comment_keyword` + `dm_message` when the funnel uses comment-to-DM.

## report.json schema (write exactly this shape)

```json
{
  "summary": "4-6 sentences: what wins in this market and what the business should do first",
  "business": { "name": "", "offer": "", "audience": "", "positioning": "" },
  "changes": "only on a repeat check (the brief has a previous summary): what is new since then, else null",
  "searches": [{ "phrase": "", "videos_seen": 0, "small_account_hits": 0, "top_views": 0,
    "verdict": "what this phrase shows: what wins in it, or why it was thin" }],
  "competitors": [{ "name": "", "platform": "tiktok", "url": "", "followers": 0, "scanned": 0, "median_views": 0,
    "posts_per_week": 0, "top_outlier": 0, "what_works": "", "note": "e.g. Instagram blocked, used TikTok" }],
  "winners": [{ "id": "w1", "found_by": "competitor_scan | search | example", "search_phrase": "the phrase, for search winners, else null",
    "author": "@handle", "author_followers": 0, "competitor": "the competitor name, or the author for search winners",
    "platform": "tiktok", "url": "", "posted_at": "2026-10-01",
    "views": 0, "likes": 0, "comments": 0, "shares": 0, "duration_s": 0, "outlier": 0,
    "poster": "leave out: filled in from the prep", "sheets": ["leave out: filled in from the prep"],
    "format": "talking_head | broll_voiceover | split_screen | faceless_motion | green_screen | skit | screen_recording | slideshow | ugc_demo | podcast_clip | other",
    "style_id": "s1", "topic": "", "hook": { "spoken": "", "on_screen": "", "visual": "" },
    "beats": [{ "t": 0, "what": "" }], "cta": "", "funnel_id": "f1 or null", "why_it_won": "",
    "measured": { "cuts_per_min": 0, "shot_median_s": 0, "visual_events_per_min": 0, "face_pct": 0, "wpm": 0, "lufs": 0 },
    "transcript": "first ~400 characters" }],
  "styles": [{ "id": "s1", "name": "", "format": "talking_head", "summary": "", "examples": ["w1"], "avg_outlier": 0,
    "measured": { "cuts_per_min": 0, "shot_median_s": 0, "face_pct": 0, "wpm": 0, "lufs": 0, "length_s": 0 },
    "recipe": { "structure": "", "pacing": "", "shots": "", "text_captions": "", "color_grade": "", "audio": "", "transitions": "" },
    "closest_template": "none", "skill_md": "the full editing SKILL.md text" }],
  "topics": [{ "topic": "", "why": "", "examples": ["w1"], "avg_outlier": 0 }],
  "hooks": [{ "pattern": "", "template": "", "examples": ["w1"] }],
  "funnels": [{ "id": "f1", "competitor": "", "type": "comment_to_dm | link_in_bio | lead_magnet | dm_keyword | website | paid_ads | community | other",
    "name": "", "offer": "", "keyword": "", "steps": [""], "evidence": ["w1", "https://..."],
    "workflow": { "keyword": "", "dm_message": "", "link": "what to link to" } }],
  "ideas": [{ "title": "", "topic": "", "format": "talking_head", "style_id": "s1", "based_on": ["w1"],
    "hooks": ["", "", ""], "script": "", "shot_list": [""], "caption": "", "cta": "", "comment_keyword": "", "dm_message": "", "why": "" }],
  "opportunities": ["gaps nobody in this market is filling"],
  "next_steps": ["the first three things to film or set up this week"]
}
```

Winner `id`s must be the agent_task ids (w1, w2...): their poster and frame sheets are attached for you.
Numbers are numbers (not strings); unknown is `null`. No em dashes anywhere in the report.

## 3. Submit

`reverse_engineer_submit_report` with `{ run_id, report }` (or `POST /v1/reverse-engineer-marketing/{run_id}/report`
with `{ "report": {...} }`). The run turns `ready`, the styles are saved as the workspace's editing styles, and a
repeat run schedules its next check. A complete report beats a perfect one that never gets sent.

## Rules

- Every winner, number and quote comes from the agent_task or a page you read. No invented examples.
- Judge by outlier, not raw views: a 40k-view video on a 5k-median account beats a 1M on a 2M-median one.
- Never copy footage, music or branding into a style skill: learn the grammar of the edit.
- Funnels cite evidence (captions, spoken CTAs, link-in-bio pages you fetched). Ideas cite winners and a style.
