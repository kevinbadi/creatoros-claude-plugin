---
name: meta-campaign-builder
description: Build and launch a Meta (Facebook + Instagram) ad campaign end to end through the Creator OS API - objective, budget and bid strategy, conversion goal (pixel event, custom conversion or instant form), audience (locations, age, gender, interests, behaviors, job titles, income, saved audiences) with a live reach estimate, placements, image / video / carousel creative, Meta's own previews, a validateOnly dry run, the human's confirmation, launch and a status check. Use when asked to create, launch, set up or plan a Meta, Facebook or Instagram ad campaign (not just boost a post). Needs the Creator OS Ads add-on and a connected Meta ad account.
version: 4
---

# Meta campaign builder

The same pipeline as the Create campaign wizard on the Meta Ads page of the Creator OS web app, for an agent:
**Account → Objective → Budget → Goal → Audience → Placements → Ad → Preview → Check → Confirm → Launch → Verify.**
Every step below is one or two Creator OS API calls. Nothing is created until step 10.

## How to call the API

- Base URL: `$CREATOROS_API_URL`, default `https://creatoros-production-5658.up.railway.app`.
  Every call sends `Authorization: Bearer $CREATOROS_API_KEY` (a `cos_live_` key; it is pinned to one workspace).
- Same calls through the other surfaces:
  - CLI: `creatoros ads:call <METHOD> <path> [--query '{...}'] [--body '{...}']`.
  - MCP (Claude, ChatGPT, ...): `ads_read` for GETs and `ads_request` for anything else, with the same path, query and body.
- Errors are `{ "error": { "code", "message", "status" } }`. `ads_addon_required` (402) means the Ads add-on is off:
  tell the human it's $19.99/month on the Ads page of the web app, and stop.
- Ids: connections are `acc_...`, ads `ad_...`, audiences `aud_...`. Meta's own ids (`act_...`, campaign, ad set, pixel,
  form, app ids) pass through as-is. Send ids back exactly as you received them.
- Money is in **whole units of the ad account's currency** (`2` = CA$2.00 on a CAD account), never cents.

## Money rules (never break these)

- A campaign spends the human's real money. Before launching, show the human the plan (step 9) and get an explicit
  yes in this conversation, unless a standing instruction (e.g. `creatoros/BRAND_VOICE.md`, a scheduled task prompt)
  says otherwise, and then stay inside its limits.
- When in doubt, launch with `"status": "PAUSED"` and tell the human how to resume it.
- Never retry a create after a timeout: it can take minutes and may have succeeded. Always send an `Idempotency-Key`
  header (one per campaign); a retry with the same key and body replays the first result instead of creating a second.
- One dry run per submission. Meta counts dry runs as writes (30 per ad account per 5 minutes).

## 0. Find the Meta ad account

1. `GET /v1/ads/connections` → the connection with `"network": "meta"`. Its `id` (`acc_...`) is **accountId** everywhere.
   None? `GET /v1/connect/meta/ads?return_to=<url>` returns an `auth_url` for the human to open.
2. `GET /v1/ads/accounts?accountId=<acc>` → pick the ad account: **adAccountId** (`act_...`), `currency`,
   `minimumDailyBudget`, `timezoneName`. `accountStatus` must be `1` (active).
   Ignore `billingStatus: "missing"`: it only means no card on file, and prepaid funds still read `missing`. Meta's own
   dry run (step 8) is the real answer on billing.
3. `GET /v1/ads/instagram-accounts?accountId=<acc>&adAccountId=<act>` → `pages[]` (each with its linked
   `instagramBusinessAccount`) and `resolved` (the default Page + Instagram account).
4. **Ask the human which Page the ad runs as and where: Instagram only, Facebook only, or both.** Never assume both:
   an ad left on automatic placements also runs on Facebook. Then send, on every create / messaging / call body:
   - `pageId`: the chosen Page (Meta needs a Page even for Instagram-only ads; it won't show on Facebook unless placed there).
   - `instagramAccountId`: the Page's linked Instagram `igUserId`, when Instagram is used.
   - Instagram only: `"placements": { "publisherPlatforms": ["instagram"] }` (every Instagram spot); Facebook only:
     `["facebook"]`; both: omit `placements` (automatic) or pick spots in step 5.
   A Page with no Instagram linked can only run on Facebook.

## 1. Objective: what people should do

| Human wants | Endpoint | Fields |
|---|---|---|
| Website visits | `POST /v1/ads/create` | `goal: "traffic"`, `linkUrl`, `callToAction` |
| Sales or sign-ups on their site | `POST /v1/ads/create` | `goal: "conversions"` + a promoted object (step 3) |
| Leads | `POST /v1/ads/create` | `goal: "lead_generation"` (instant form) or `"lead_conversion"` (website, pixel) |
| Messages | `POST /v1/ads/messaging` | `destination: "messenger" \| "instagram_direct" \| "whatsapp"` |
| Phone calls | `POST /v1/ads/call` | `phoneNumber` (E.164, e.g. `+14165551234`) + `linkUrl` (a real website) |
| Awareness | `POST /v1/ads/create` | `goal: "awareness"`, `linkUrl`, `callToAction` |
| Engagement | `POST /v1/ads/create` | `goal: "engagement"`, `linkUrl`, `callToAction` |

`callToAction` values: `LEARN_MORE`, `SIGN_UP`, `SHOP_NOW`, `GET_OFFER`, `SUBSCRIBE`, `DOWNLOAD`, `CONTACT_US`,
`BOOK_TRAVEL`, `APPLY_NOW`, `ORDER_NOW`. Call and message buttons come from their own endpoints, never from `create`.
WhatsApp needs a WhatsApp Business number paired with the Page; Instagram Direct needs Instagram linked to the Page.

### Tracking the destination

For any ad with a website link, add `tracking` to the create / messaging / call body:

```json
"tracking": {
  "pixelId": "<pixels[0].pixelId from step 3>",
  "urlTags": [
    { "key": "utm_source", "value": "meta" }, { "key": "utm_medium", "value": "paid_social" },
    { "key": "utm_campaign", "value": "{{campaign.name}}" }, { "key": "utm_content", "value": "{{ad.id}}" }
  ]
}
```

UTM tags land on Meta's `url_tags` (Meta fills in `{{...}}` macros) so the human's analytics attributes each visit;
`pixelId` lets Meta measure page views and sign-ups even on a traffic campaign. To count clicks in Creator OS too,
`POST /v1/links { url, title }` → use `short_url + "?s=meta-ads"` as `linkUrl` (the ad then shows go.creatoros.ca as its
domain, so only when the human wants that). Change tags on a live ad: `PATCH /v1/ads/{adId}/tracking-tags { urlTags }`
(rebuilds the creative, which goes through review again); read them with `GET` on the same path.

## 2. Budget, schedule and bid strategy

- `budgetType`: `daily` (default, recommended) or `lifetime` (needs `endDate`). `budgetAmount` in whole currency units.
- Minimum: the ad account's `minimumDailyBudget` per day (e.g. CA$1.41). For a lifetime budget, total ÷ days.
- **A daily budget must run at least 24 hours.** Use date-only values: `"endDate": "2026-10-01"` runs to 23:59 that day in
  the ad account's timezone. The cheapest real test is the minimum daily budget (rounded up) for 1 day, ending tomorrow.
- `startDate` only if it starts later than now (date-only is fine). Omit `endDate` on a daily budget to run until paused.
- Bid strategy goes in `platformSpecificData` (omit it for the default):

| Strategy | Send | Use when |
|---|---|---|
| Highest volume (default) | nothing | Almost always, and always for tests |
| Cost per result goal | `{ "bidStrategy": "COST_CAP", "bidAmount": 5 }` | The human has a target cost per result |
| Bid cap | `{ "bidStrategy": "LOWEST_COST_WITH_BID_CAP", "bidAmount": 3 }` | They want strict control per auction |
| ROAS goal | `{ "bidStrategy": "LOWEST_COST_WITH_MIN_ROAS", "roasAverageFloor": 2 }` | Sales campaigns with purchase values only |

A cost or bid set too low means Meta spends little or nothing. Say so if the human picks one.

## 3. Goal: what counts as a result

`GET /v1/ads/conversion-goals?accountId=<acc>&adAccountId=<act>` returns every goal with what it needs and whether this ad
account can use it now (`available`, `missing`), plus the options: `pixels`, `customConversions`, `leadForms`,
`applications`, `catalogs[].productSets`. Use only what it lists; never invent ids.

| goal | promotedObject | Pick from |
|---|---|---|
| `conversions` (sales) | `{ pixelId, customEventType }` or `{ customConversionId }` | `pixels[].pixelId` + a sale-type event (`PURCHASE`, `ADD_TO_CART`, `INITIATE_CHECKOUT`, `START_TRIAL`, `SUBSCRIBE`, ...), or `customConversions` |
| `lead_conversion` (website leads) | same shape | a lead-type event (`LEAD`, `COMPLETE_REGISTRATION`, `SCHEDULE`, `CONTACT`, ...) |
| `lead_generation` (instant form) | none; send `leadGenFormId` | `leadForms[].leadGenFormId`. `linkUrl` not needed |
| `app_promotion` | `{ applicationId, objectStoreUrl }` | `applications` (needs the app's SDK for installs to be tracked) |
| `catalog_sales` | `{ productSetId, pixelId, customEventType }` | `catalogs[].productSets` (needs a Business Manager catalog) |

- Meta rejects a lead-type event on `conversions` and a sale-type event on `lead_conversion`.
- If a pixel has never fired (`lastFiredTime: null`), warn the human: Meta can't optimize until the site sends events.
- Prefer goals that already track (the web app only offers `conversions`, `lead_conversion`, `lead_generation`). Suggest
  app installs or catalog sales only when the human already has that setup.
- Website visits, awareness, engagement, messages and calls have no goal to pick.

## 4. Audience

Start broad; Meta finds the right people inside it. Send these as top-level fields on the create body:

- Locations: `countries: ["US", "CA"]`, or cities with a radius:
  `GET /v1/ads/targeting/search?accountId=<acc>&dimension=geo&geoType=city&q=Toronto` → take `results[].id` →
  `cities: [{ "key": "<id>", "radius": 25, "distance_unit": "kilometer" }]` (cities replace countries).
  Regions, zips and metros work the same way (`geoType=region|zip|metro`, fields `regions` / `zips` / `metros`).
- **EU countries** (incl. Ireland): also send `dsaBeneficiary` and `dsaPayor` (who the ad benefits / who pays, usually the
  business name), or set them once per ad account with `PATCH /v1/ads/accounts { accountId, adAccountId, defaultDsaBeneficiary, defaultDsaPayor }`.
- `ageMin` / `ageMax` (18 to 65), `gender: "male" | "female"` (omit for everyone).
- Interests: `dimension=interest` search → `interests: [{ "id", "name" }]`.
- Behaviors: `dimension=behavior` → `behaviors: [{ "id", "name" }]` (e.g. small business owners).
- Job titles: `dimension=workPosition` → `workPositions: [{ "id", "name" }]`. Few people list one: keep it optional.
- Income: `incomeTier: "top_5" | "top_10" | "top_10_25" | "top_25_50"`, **US audiences only**.
- A saved audience (customer list, website visitors, lookalike): `GET /v1/ads/audiences?accountId=<acc>&adAccountId=<act>`
  → `audienceId: "aud_..."`.
- Reach: `POST /v1/ads/targeting/reach-estimate { accountId, adAccountId, spec }` with the same targeting fields
  → `{ lower, upper }`. **This endpoint spells the city unit `distanceUnit`**; create uses `distance_unit`. Under ~1,000
  people is too narrow: loosen before launching. Stacked filters shrink it fast.
- Save a preset for next time: `POST /v1/ads/audiences { accountId, type: "saved_targeting", name, spec }` (spec uses
  `distanceUnit`), then reuse it with `savedTargetingId`.

## 5. Placements

Respect step 0.4: on one app, `publisherPlatforms` is just that app. On both, the default is to omit `placements` (automatic; Meta
shifts budget to what works). Only restrict further when the human asks, e.g. specific Instagram spots:

```json
"placements": { "publisherPlatforms": ["instagram"], "instagramPositions": ["stream", "story", "reels", "explore"] }
```

Platforms: `facebook`, `instagram`, `messenger`, `threads`, `audience_network`. Positions: `facebookPositions`
(`feed`, `story`, `facebook_reels`, `video_feeds`, `marketplace`, `search`, `instream_video`, `right_hand_column`),
`instagramPositions` (`stream`, `story`, `reels`, `explore`, `explore_home`, `profile_feed`, `ig_search`),
`messengerPositions`, `threadsPositions`, `audienceNetworkPositions`. `devicePlatforms: ["mobile"]` to limit devices.

## 6. Creative

Copy: `body` (primary text; first ~125 characters show), `headline` (under ~40 characters), optional `description`.
Write it in the human's voice (`creatoros/BRAND_VOICE.md` if present) and show it to them.

- **Image:** `imageUrl` (public https, or a media URL from `POST /v1/media`). 1080×1080 or 1080×1350; 1080×1920 for
  Stories and Reels. Instagram rejects images under 500 px wide.
- **Video:** first `POST /v1/ads/videos { accountId, adAccountId, videoUrl }` (waits while Meta processes it, can take
  minutes) → `video.id` → send `"video": { "id": "<id>", "thumbnailUrl": "<optional cover>" }` instead of `imageUrl`.
- **Carousel** (create only): `carouselCards: [{ imageUrl, headline, description?, linkUrl? }]`, 2 to 10 cards, plus
  top-level `body`, `linkUrl`, `callToAction`. No top-level `imageUrl`.

## 7. Preview (nothing is created)

`POST /v1/ads/preview { accountId, adAccountId, formats, creativeSpec }` → `previews[].html`, each an `<iframe>` whose
`src` (facebook.com) shows Meta's render. Formats: `MOBILE_FEED_STANDARD`, `FACEBOOK_STORY_MOBILE`,
`FACEBOOK_REELS_MOBILE`, `INSTAGRAM_STANDARD`, `INSTAGRAM_STORY`, `INSTAGRAM_REELS` (only the placements in use).

```json
"creativeSpec": { "object_story_spec": {
  "page_id": "<pageId>", "instagram_user_id": "<igUserId>",
  "link_data": { "link": "<linkUrl>", "message": "<body>", "name": "<headline>", "image_hash": "<hash>",
                 "call_to_action": { "type": "LEARN_MORE", "value": { "link": "<linkUrl>" } } } } }
```

Instagram previews only draw images from the ad account's library: first `POST /v1/ads/images { accountId,
adAccountId, imageUrl }` → `image.hash`, then use `image_hash` (Facebook previews also accept `picture: <url>`).
Video: `video_data: { video_id, image_url, message, title, call_to_action }`. Carousel: `link_data.child_attachments`.
Give the human the preview links if they can open them.

## 8. Dry run

Send the exact body you will launch, plus `"validateOnly": true`, to the same endpoint. Always `200`:
`{ valid, checks: [{ check, status: passed | warning | failed, message }], checked_by, message }`.
Creator OS checks fields, goal, dates (incl. the 24-hour rule), connection, ad account, minimum budget, bid strategy,
placements and creative, then (create only, Meta / single image or existing video) Meta's own dry run. Meta can't
dry-run carousels or new video uploads; that is reported as passed with a note. Fix every `failed` and run it again.

## 9. Confirm with the human

Show a short plan and wait for a yes:

```
Objective: Website visits → www.creatoros.ca (Learn more)
Budget: CA$2/day, today to Oct 1 (up to CA$2), highest volume bidding
Goal: none (optimizes for landing page views)
Audience: Toronto +25 km, 25 to 45, interest: social media marketing (~480K to 570K people)
Placements: automatic   Creative: image + "The operating system for social media"
Meta's dry run: passed. Launch now, or create it paused?
```

## 10. Launch

`POST` the same body without `validateOnly`, with `"status": "ACTIVE"` (or `"PAUSED"`) and an `Idempotency-Key` header.
Response: `ad.id` (`ad_...`), `status: "pending_review"`, Meta campaign / ad set ids. A carousel or multi-creative
create returns `ads` instead. Meta reviews every new ad, usually within a few hours.

## 11. Verify and report

- `GET /v1/ads/<ad_id>` → `status`, `reviewStatus`. `GET /v1/ads/tree` shows it under its campaign.
- Tell the human: what launched, how much it can spend, that it's in review, and where to see it (Meta Ads page →
  Campaigns in Creator OS, or Meta Ads Manager).
- Pause: `PUT /v1/ads/<ad_id>/status { "status": "paused" }`, or the whole campaign:
  `PUT /v1/ads/campaigns/<platformCampaignId>/status { "status": "paused", "platform": "facebook" }`.
- Results: `GET /v1/ads/<ad_id>/analytics` (spend, impressions, reach, clicks, CTR, CPC, conversions, ROAS) once it runs.

## Common failures

| Message | Fix |
|---|---|
| Meta needs the ad to run at least 24 hours | End on the next day or later |
| Below the minimum of X a day | Raise `budgetAmount` (lifetime: total ÷ days) |
| radius and distanceUnit / distance_unit must be set together | Reach estimate and saved targeting use `distanceUnit`, create uses `distance_unit` |
| Update payment method (subcode 1359188) | The ad account has no payment method or funds: the human adds one in Meta billing |
| 1815089 | The Page hasn't accepted the Lead Ads terms: facebook.com/ads/leadgen/tos |
| 2446886 | WhatsApp isn't paired with the Page: use Messenger or pair it in Meta Business |
| 324 | Meta can't fetch the image: use a public https URL or upload it with `POST /v1/media` |
| 429 on a dry run | Meta's write limit on this ad account: wait a few minutes, validate once |
| Reconnect your WhatsApp number to your Facebook Page or Instagram account | Meta sees a broken WhatsApp link on the Page: the human reconnects or removes it in Meta Business Suite (Page settings → Linked accounts → WhatsApp), then validate again. Affects every ad on that Page |
