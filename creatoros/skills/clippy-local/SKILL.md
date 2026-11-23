---
name: clippy-local
description: Run Clippy, the Creator OS clipper, on your own machine with your own Claude doing the thinking. Download a stream, podcast or video, transcribe it locally, pick the best moments yourself, render captioned vertical clips (speaker tracking, split screens, TikTok-style hook box, word-by-word captions, dead air cut) with the same engine Creator OS runs, review them, then upload them to Creator OS so an autopilot's pages post them (and submit them to its Content Rewards campaign). No AI key and no server AI cost. Use when the user wants to clip a video locally, clip with their own Claude Code plan, or render clips on their machine.
version: 1
---

# Clippy, local

You are the brain, the user's machine is the editing suite, Creator OS is the posting desk.

Two ways to clip with your own Claude (pick with the user):

1. **Zero setup (server renders, you only pick).** Start a run with `clipper_clip_stream` (or an autopilot) and no AI key saved, or `brain: "agent"`. Creator OS downloads and transcribes it, then the run waits in `clipper_pending`. Read it with `clipper_get_transcript`, send your moments with `clipper_submit_picks`, and Creator OS cuts, captions, renders and posts them. Nothing to install. Use this unless the user wants everything on their machine.
2. **Fully local (this skill).** Everything up to the finished MP4 runs here: download, transcription, your picks, rendering. Only the finished clips go to Creator OS (`clipper_import_clips`). Good for big backlogs, home IPs that YouTube does not block, and users who want no queue.

The rest of this skill is path 2.

## Setup (once)

- Node 20 or newer.
- ffmpeg with libass: `ffmpeg -filters | grep subtitles` must list the `subtitles` filter (Homebrew's `ffmpeg` has it).
- Python 3 with `pip install numpy opencv-python Pillow faster-whisper` (the first run downloads the Whisper models, about 500 MB).
- `yt-dlp` for links (`brew install yt-dlp` or `pip install yt-dlp`).
- For upload: `export CREATOROS_API_KEY=cos_live_...` (Creator OS, Settings, API key). Never print it or paste it into a file in the repo.
- Disk: a source video is often several GB. Check free space first and delete the job folder when done.

The CLI is `scripts/clip.mjs` in this skill's folder (the plugin ships the engine next to it in `scripts/clipper/` and the fonts in `scripts/variations/fonts/`). Below, `clip` means `node <this skill>/scripts/clip.mjs`.

## 1. Prepare

```bash
clip prepare "<youtube / twitch / kick / any link, or a local file>" --out ./clippy/<short-name> [--from 600 --to 4200]
```

Downloads the video (up to 1080p), transcribes it with faster-whisper and writes into the folder:

- `transcript.txt`: one line per sentence, `[m:ss.s | 723.4s] text`, plus `LOUD +N dB` lines for the loudest seconds (laughter, yelling, hype).
- `transcript.json`, `source.json`.

Long streams: use `--from` / `--to` (seconds) to scan up to about 3 hours at a time.

## 2. Pick the moments (you)

Read `transcript.txt` and write `picks.json` in the folder. Ask the user for the clip count (default 5, up to 10 per video), the length range (default 20 to 60 s, or the autopilot's / campaign's rules) and what the clips are for. If they work a Content Rewards campaign, follow its brief.

```json
{ "clips": [
  { "start": 397.0, "end": 419.5,
    "title": "Your South Node is who you were in a past life",
    "hook": "This is who you were before",
    "reason": "Clear crash course with a curiosity hook",
    "score": 64,
    "start_words": "South Node is your past life",
    "end_words": "experience a lot of expansion",
    "drops": [{ "start_s": 452.0, "end_s": 462.4, "first_words": "So you're gonna ask", "last_words": "know about that too" }],
    "fixes": [{ "heard": "citaloa", "correct": "Sinaloa" }] }
] }
```

Times are seconds in the original video (the `s` value in each transcript line). How to pick, the same rules Clippy uses on the server:

- Hunt bangers, the moments people send to a friend: the room losing it laughing (LOUD lines on a podcast), a wild story with a payoff, a savage roast or comeback, a hot take that splits the comments, a heated disagreement, a shocking confession, number or fact, a quotable line. Funny and wild beat wise. Skip calm explainers unless the take itself is explosive.
- Gaming streams: huge reactions (LOUD lines), clutch plays, fails, chaos, rage. Start 2 to 5 s before the reaction so the viewer sees what caused it; end right after it peaks.
- Every clip must make sense with zero context. Never sponsor reads, "starting soon", tech trouble or dead air. No two clips on the same story or point, and no overlaps.
- The first spoken sentence is the hook: a claim, a stake, a conflict, a question, a number. Never start on filler ("so", "and", "like", "yeah", "I mean", "you know"). End on the payoff or the laugh after it, never mid-sentence or on a new topic.
- `start_words` / `end_words`: copy EXACTLY the first and last 4 to 8 words of your cut from the transcript. The renderer cuts on those words, so cuts land between words.
- `drops`: up to 3 stretches inside the clip to cut out (each at least 2 s): tangents, a repeated point, filler before the payoff. Same exact-words rule.
- Length: between the minimum and maximum after drops. Shorter is better: aim for 20 to 40 s unless the story needs more.
- `title`: a searchable post title, 70 characters max. `hook`: on-screen text for the first seconds, 3 to 7 words, adds the stake or twist the first sentence does not say (never restates it), and the clip pays it off.
- `score`: your honest 0 to 100 on the Virality rubric: hook 25, retention 20, topic 15, emotion 15, clarity 10, shareability 10, platform fit 5. Most moments land 45 to 75; 75+ only for one you would bet on. An autopilot's pages only post clips at or above its bar (default 67), so do not inflate it.
- `fixes`: words the transcript clearly misheard (names, places, brands, slang), so the captions are spelled right.
- No em dashes or en dashes anywhere. Same language as the video.

## 3. Render

```bash
clip render ./clippy/<short-name> [--autopilot <autopilot id>] [--style podcast|gaming] [--layout auto] [--aspect 9:16] [--design design.json] [--names "Astra, Sinaloa"]
```

- `--autopilot` uses that autopilot's caption design, style and minimum length (needs `CREATOROS_API_KEY`; `clipper_autopilot_list` shows the ids). Otherwise the default design (bold pop captions, white hook box) applies; `--design` takes a JSON of design fields (see `clipper_designs`).
- `--names`: names and words Whisper should spell right. Only names, never a sentence or title (that makes it skip words).
- Podcast style follows whoever is talking and punches in and out; two people trading lines get a split screen. Gaming style puts the facecam over the gameplay; if the facecam isn't found, pass a `boxes` object in that pick: `{ "facecam": { "x": 0.75, "y": 0.05, "w": 0.22, "h": 0.3 } }` (fractions of the frame).
- Output: `out/clip_N.mp4`, `out/cover_N.jpg`, `out/manifest.json`. A pick that fails is listed with its error; the rest still render.

## 4. Review

Before anything leaves the machine, check every clip: extract a frame at 1 s (hook box) and a few seconds in (captions) with ffmpeg and look at them, read the clip's transcript in `manifest.json`, and confirm it starts on the hook and ends on the payoff. Re-cut by editing `picks.json` and rendering again. Show the user the clips (paths, titles, scores) and let them drop any.

## 5. Upload (only when the user says so)

```bash
clip upload ./clippy/<short-name> [--autopilot <id> --yes]
```

Uploads each MP4 and cover to Creator OS (`POST /v1/media`), then imports them as one run (`POST /v1/clipper/clips/import`, MCP `clipper_import_clips`). They show in the Clippy library like any other clip.

- With `--autopilot`, the clips join that autopilot's pages: the ones scoring at or above its bar get booked into the pages' posting slots and, for a Content Rewards autopilot, submitted to the campaign. That posts publicly, so the CLI asks for `--yes`: only add it after the user confirms.
- Without `--autopilot`, nothing is posted. The user can post a clip later (`clipper_post_clip`).

Delete the job folder afterwards (`rm -rf ./clippy/<short-name>`): source videos are large.
