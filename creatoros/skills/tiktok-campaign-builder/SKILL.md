---
name: tiktok-campaign-builder
description: Build and launch TikTok ads end to end through the Creator OS API - a Spark Ad that boosts one of the creator's own TikToks (or another creator's with a Spark Code), or a new video campaign (objective, budget and bidding, countries / age / gender / interests, the identity it runs as, a 9:16 video, caption and button, pixel conversions), a validateOnly check, the human's confirmation, launch and a status check, plus reading results from TikTok's live report. Use when asked to boost a TikTok, run TikTok ads, or create, launch or plan a TikTok ad campaign. Needs the Creator OS Ads add-on and a connected TikTok Ads account.
version: 1
---

# TikTok campaign builder

The same pipeline as the TikTok Ads page of the Creator OS web app (Boost a TikTok tab and the Create campaign wizard), for an agent:
**Account → Spark boost or new video → Objective → Budget → Audience → Video → Check → Confirm → Launch → Verify.**
Nothing is created until step 9.

## How to call the API

- Base URL: `$CREATOROS_API_URL`, default `https://creatoros-production-5658.up.railway.app`.
  Every call sends `Authorization: Bearer $CREATOROS_API_KEY` (a `cos_live_` key, pinned to one workspace).
- Same calls through the other surfaces:
  - CLI: `creatoros ads:call <METHOD> <path> [--query '{...}'] [--body '{...}']`.
  - MCP: `ads_list_connections`, `ads_list_ad_accounts`, `ads_best_posts`, `ads_tiktok_identities`, `ads_search_targeting`,
    `ads_boost_post`, `ads_create_ad`, `ads_set_status`, `ads_update_budget`; `ads_read` / `ads_request` for anything else.
- Errors are `{ "error": { "code", "message", "status" } }`. `ads_addon_required` (402) means the Ads add-on is off:
  tell the human it's $19.99/month on the Ads page of the web app, and stop.
- Ids: connections `acc_...`, ads `ad_...`, posts `post_...`, pixels and interests `obj_...`. TikTok's own ids (advertiser,
  campaign, ad group) pass through as-is. Send every id back exactly as you received it.
- Money is in **whole units of the advertiser's currency**, never cents. TikTok's floor is **20 a day per ad group**
  (a lifetime budget must average 20 a day).

## Money rules (never break these)

- Ads spend the human's real money. Before launching, show the plan (step 8) and get an explicit yes in this
  conversation, unless a standing instruction says otherwise, and then stay inside its limits.
- **TikTok has no dry run.** `validateOnly: true` runs Creator OS's checks only (fields, countries, the $20 floor,
  pixel id shape, creative, the Spark identity). TikTok can still reject the ad at create or in review. Say so.
- Prefer creating paused (`status: "PAUSED"` on create; on a boost, pause the returned ad with
  `PUT /v1/ads/{adId}/status {"status":"paused"}`) when the human wants to look first.

## 1. Account

`GET /v1/ads/connections` → the connection with `network: "tiktok"` (its `id` is the `accountId` for everything below;
its `parentAccountId` is the linked TikTok posting account, which Spark Ads need).
`GET /v1/ads/accounts?accountId=<acc_>` → the advertiser: `adAccountId`, `name`, `currency`, `accountStatus`
(anything but `STATUS_ENABLE` can't deliver: stop and tell the human).
`GET /v1/ads/tiktok-identities?accountId=<acc_>&adAccountId=<id>` → who ads can run as (`identityId`, `identityType`,
`username`).

No TikTok connection: `GET /v1/connect/tiktok/ads?return_to=https://www.creatoros.ca/app/ads/tiktok` and give the human
the `auth_url`. Tell them to connect the TikTok account itself first (Connect page) so the two link and Spark Ads work.

## 2. Spark boost or new video?

- The human has a TikTok that's already doing well → **Spark boost** (step 2a). Keeps its likes, comments and @handle;
  usually the cheapest results.
- They have a new video file, or want a pixel-optimized sales campaign → **new video** (steps 3 to 6).

### 2a. Spark boost

`GET /v1/ads/best-posts?accountId=<acc_>&adAccountId=<id>` → `posts` (best first by likes + 2x comments + 3x shares)
and `postingAccountId`. Suggest the top 3 with their numbers and let the human pick.

The video's owner (`posts[].account`, e.g. `@handle`) must be one of the identities from step 1. If it isn't, TikTok will
likely refuse. Two ways out, tell the human:
1. Authorize that account on the advertiser in TikTok Ads Manager (Assets, Identities), then boost normally.
2. A **Spark Code**: in the TikTok app, the video's ⋯ menu, Ad settings, turn on ad authorization, copy the code.
   Then boost with `accountId` = the TikTok Ads connection (`acc_` from step 1), `platformPostId` = the TikTok video id
   (the number in its URL after `/video/`) and `sparkAuthCode`. This also boosts another creator's video.

Request (`POST /v1/ads/boost`):

```json
{
  "platformPostId": "post_... (from best-posts)",
  "accountId": "<postingAccountId>",
  "adAccountId": "<advertiser id>",
  "name": "Spark: <first words of the caption>",
  "goal": "video_views",
  "budget": { "amount": 20, "type": "daily" },
  "endDate": "YYYY-MM-DD",
  "targeting": { "countries": ["US"], "ageMin": 18 },
  "linkUrl": "https://... (optional; required for goal traffic)",
  "callToAction": "LEARN_MORE"
}
```

Goals: `video_views`, `engagement` (follows, likes, profile visits), `traffic` (needs `linkUrl` + `callToAction`),
`awareness`. Optional `bidStrategy: "COST_CAP"` + `bidAmount`. Then go to step 7.

## 3. Objective (new video)

| goal | for | needs |
|---|---|---|
| `traffic` | website visits | `linkUrl` + `callToAction` |
| `conversions` | sales or sign-ups | a pixel: `promotedObject.pixelId` + `customEventType` |
| `video_views` | the most people watching | nothing extra |
| `awareness` | reach | nothing extra |
| `engagement` | follows, likes, profile visits | nothing extra |

Conversions: `GET /v1/accounts/<acc_>/tracking-tags?adAccountId=<id>` lists pixels. `pixelId` is the tag's **`id`**
(an `obj_...` token, the numeric TikTok id underneath), **never** the `siteTagId` code (`CCC3...`), which TikTok rejects.
`GET /v1/accounts/<acc_>/tracking-tags/<id>?adAccountId=<id>` → `events[]`: `customEventType` must be one of those
`type`s (e.g. `SHOPPING` is purchase on some pixels, not `ON_WEB_ORDER`). No pixel: offer `traffic` instead, and tell the
human to create one in TikTok Events Manager.

Tracking: add UTM tags to `linkUrl` itself; TikTok fills its macros on click (`__CAMPAIGN_NAME__`, `__CAMPAIGN_ID__`,
`__AID__`, `__CID__`). For click counting on the Creator OS Links page, wrap the link with `POST /v1/links {"url": ...}`
and use `<short_url>?s=tiktok-ads`.

## 4. Budget and bidding

`budgetAmount` + `budgetType` (`daily` or `lifetime`; lifetime needs `endDate`). At least 20 a day.
Bidding: default maximum delivery (omit `bidStrategy`); `COST_CAP` + `bidAmount` (target cost per result) when the human
has a cost target; `LOWEST_COST_WITH_MIN_ROAS` + `roasAverageFloor` only on value-optimized conversion accounts.

## 5. Audience

`countries` is **required** (ISO codes). Age brackets: `ageMin` 18 / 25 / 35 / 45 / 55, `ageMax` 24 / 34 / 44 / 54 (omit for
55+). `gender`: `male` or `female` (omit for everyone). Interests:
`GET /v1/ads/targeting/search?accountId=<acc_>&dimension=interest&q=fitness` → `interests: [{ "id": "obj_...", "name": "..." }]`.
Start broad; TikTok finds the people inside it. Also available: `regions`, `cities`, `zips`, `metros`, `incomeTier`,
`audienceInclude` / `audienceExclude` (processed Custom Audiences).

## 6. Video

- The video URL goes in **`imageUrl`** (TikTok's create is video only). 9:16 vertical, 5 to 60 seconds, MP4 / MOV / MPEG
  up to 500 MB, 720p or better. A local file: `POST /v1/media` (raw body) first and use the returned URL.
- `body` is the caption, up to 100 characters. TikTok ads have **no headline** (one is ignored with a warning).
- `callToAction` only with `linkUrl`: `LEARN_MORE`, `SHOP_NOW`, `SIGN_UP`, `DOWNLOAD`, `ORDER_NOW`, `BOOK_NOW`,
  `CONTACT_US`, `APPLY_NOW`, `SUBSCRIBE`, `WATCH_NOW`, `GET_QUOTE`.
- `identityId` + `identityType` from step 1: the @handle shown on the ad.

Full request (`POST /v1/ads/create`):

```json
{
  "accountId": "<acc_>", "adAccountId": "<advertiser id>", "name": "Website visits · 2026-10-01",
  "goal": "traffic", "budgetAmount": 20, "budgetType": "daily", "endDate": "YYYY-MM-DD",
  "body": "Run all your socials from one place #creatoros",
  "imageUrl": "https://.../ad.mp4",
  "linkUrl": "https://www.example.com/?utm_source=tiktok&utm_campaign=__CAMPAIGN_NAME__", "callToAction": "LEARN_MORE",
  "countries": ["US", "CA"], "ageMin": 18,
  "interests": [{ "id": "obj_...", "name": "Marketing & Advertising" }],
  "identityId": "<identityId>", "identityType": "TT_USER",
  "status": "ACTIVE"
}
```

Conversions add `"promotedObject": { "pixelId": "obj_...", "customEventType": "SHOPPING" }`.

## 7. Check

Send the exact request with `"validateOnly": true` (same endpoint). The answer is always 200:
`{ valid, checks: [{ check, status: passed|warning|failed, message }], message }`. Fix every `failed` and say every
`warning` out loud (the Spark identity warning especially). Re-check after any change: what launches must be what was
checked.

## 8. Confirm

Show the human, in plain words: boost or new video, which video, goal, daily budget, dates and the most it can spend
(daily x days), countries / age / interests, who it runs as, the link and button, paused or live. Mention that TikTok
reviews ads (usually within a day) and that the check isn't TikTok's own. Wait for a clear yes.

## 9. Launch

Same request without `validateOnly`, with an `Idempotency-Key` header (any UUID, reused on a retry, so a timeout never
creates a second campaign). Never retry without it.

## 10. Verify

`GET /v1/ads?accountId=<acc_>` (and `?accountId=<postingAccountId>` for Spark boosts, which sync under the TikTok
account) → the new ad with `status` (`pending_review` at first) and `reviewStatus`. Report it, and how to pause:
`PUT /v1/ads/{adId}/status {"status":"paused"}`, or the Campaigns tab of the TikTok Ads page.

## Reading results

- `GET /v1/ads/tree?fromDate=&toDate=` → campaigns (filter `platform: "tiktok"`) with spend, impressions, clicks,
  `videoPlayActions`, conversions.
- Live from TikTok: `GET /v1/ads/insights?accountId=<acc_>&adAccountId=<id>&dataLevel=AUCTION_ADVERTISER&dimensions=stat_time_day&metrics=spend,impressions,clicks,reach,conversion&fromDate=&toDate=`
  (`stat_time_day` spans 30 days at most: split longer ranges). Who saw it: same call with `reportType=AUDIENCE` and
  `dimensions=age`, `gender`, `country_code` or `platform` (device). Rows are `{ dimensions, metrics }` with string values.
- Change a budget: `PUT /v1/ads/campaigns/{campaignId} {"platform":"tiktok","budget":{"amount":30,"type":"daily"}}`.
- Swap the creative or targeting of a live ad: `PUT /v1/ads/{adId}`.
