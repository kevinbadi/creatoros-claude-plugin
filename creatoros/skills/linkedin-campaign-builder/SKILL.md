---
name: linkedin-campaign-builder
description: Build and launch LinkedIn ads end to end through the Creator OS API - a sponsored post from a Company Page (single image or video) targeted by industry, seniority, job function, company size and location, with the audience size, LinkedIn's suggested bid and budget range, Lead Gen Forms, dynamic UTMs, a validateOnly check, the human's confirmation, launch and a status check; or boosting an existing Company Page post; plus reading firmographic results (who saw it by seniority, industry, company size). Use when asked to create, launch, plan or report on LinkedIn ads or B2B ads. Needs the Creator OS Ads add-on and a connected LinkedIn Ads account.
version: 1
---

# LinkedIn campaign builder

The same pipeline as the Create campaign wizard on the LinkedIn Ads page of the Creator OS web app, for an agent:
**Account + Page → Objective → Audience → Budget + bid → Ad → Check → Confirm → Launch → Verify.**
Nothing is created until step 8.

## How to call the API

- Base URL: `$CREATOROS_API_URL`, default `https://creatoros-production-5658.up.railway.app`.
  Every call sends `Authorization: Bearer $CREATOROS_API_KEY` (a `cos_live_` key, pinned to one workspace).
- Same calls through the other surfaces:
  - CLI: `creatoros ads:call <METHOD> <path> [--query '{...}'] [--body '{...}']`.
  - MCP: `ads_list_connections`, `ads_list_ad_accounts`, `ads_linkedin_pages`, `ads_search_targeting`, `ads_create_ad`,
    `ads_boost_post`, `ads_set_status`, `ads_update_budget`, `ads_list_leads`; `ads_read` / `ads_request` for anything else.
- Errors are `{ "error": { "code", "message", "status" } }`. `ads_addon_required` (402): the Ads add-on is off; it's
  $19.99/month on the Ads page of the web app. Stop.
- Ids: connections `acc_...`, ads `ad_...`, targeting values `obj_...` (LinkedIn URNs underneath). LinkedIn's own ids
  (ad account, Campaign Group, Campaign, `urn:li:organization:N`) pass as-is.
- Money is whole units of the ad account currency. **LinkedIn's floor is 10 a day** (100 for a lifetime budget).

## Money rules (never break these)

- Ads spend the human's real money. Show the plan (step 7) and get an explicit yes first, unless a standing instruction
  says otherwise, and then stay inside its limits.
- **LinkedIn has no dry run.** `validateOnly: true` is Creator OS's own check (goals, creative, targeting rules, the
  minimum). LinkedIn reviews every ad (usually under a day) and can still reject it. Say so.
- `status: "PAUSED"` pauses the new Campaign Group so the human can look before it spends.

## 1. Account and Company Page

`GET /v1/ads/connections` → the connection with `network: "linkedin"` (its `id` is `accountId`).
`GET /v1/ads/accounts?accountId=<acc_>` → ad accounts (`adAccountId`, numeric).
`GET /v1/ads/linkedin-pages?accountId=<acc_>` → Company Pages (`organizationId` = `urn:li:organization:N`). The ad is a
sponsored post from that Page (it never shows on the Page's feed). The member must be an Administrator or Sponsored
Content Poster of the Page, and the Page linked to the ad account, or LinkedIn answers 403.
No connection: the LinkedIn account must be connected first (Connect page), then
`GET /v1/connect/linkedin/ads?return_to=https://www.creatoros.ca/app/ads/linkedin` (usually no second login).

## 2. Objective

| `goal` | for | needs |
|---|---|---|
| `traffic` | website visits | `linkUrl` |
| `lead_generation` | leads on a LinkedIn form (prefilled from the profile) | `leadGenFormId` (`GET /v1/ads/lead-forms?accountId=`) |
| `engagement` | reactions, comments, follows | – |
| `awareness` | impressions | – |
| `video_views` | video watches | a video ad |
| `job_applicants` | job posts | the `jobs` format in `platformSpecificData` |

`conversions` is boost-only on LinkedIn. Tracking: add `utm_source=linkedin&utm_medium=paid` to `linkUrl`; after launch
set LinkedIn's dynamic UTMs on the campaign through the new ad:
`PATCH /v1/ads/{adId}/tracking-tags { "dynamicValueParameters": { "utm_campaign": "CAMPAIGN_NAME", "utm_content": "CREATIVE_ID" } }`
(other tokens: `CAMPAIGN_ID`, `CAMPAIGN_GROUP_ID`, `CAMPAIGN_GROUP_NAME`, `ACCOUNT_ID`, `ACCOUNT_NAME`; never the same
keys as the static UTMs). Not on lead gen ads.

## 3. Audience

LinkedIn's strength is targeting by work. Search each facet on the LinkedIn connection:
`GET /v1/ads/targeting/search?accountId=<acc_>&dimension=<d>&q=<text>` with `d` = `industry`, `seniority`,
`jobFunction`, `companySize`, `interest`, `behavior` or `geo` → `results[].id` (send back as-is) and `name`.

```json
"targeting": {
  "countries": ["US", "CA"],
  "regions": [{ "key": "obj_..." }],
  "industries": ["obj_..."], "seniorities": ["obj_..."], "jobFunctions": ["obj_..."], "companySizes": ["obj_..."],
  "interests": [{ "id": "obj_..." }]
}
```

Rules: at least one location (none = United States). `jobTitles` can't be combined with `seniorities` or `jobFunctions`.
No cities, ZIPs, metros, radius or income on LinkedIn; age and gender are ignored. Aim for 50,000+ people:
`POST /v1/ads/targeting/reach-estimate { accountId, adAccountId, spec: <targeting> }` → `lower` / `upper`.

## 4. Budget and bidding

`budgetAmount` + `budgetType` (`daily` or `lifetime` with `endDate`). Before choosing, ask LinkedIn:
`POST /v1/ads/targeting/bid-pricing { accountId, adAccountId, spec: <targeting>, bidType: "CPC", objectiveType: "WEBSITE_VISIT", currency }`
→ `pricing.suggestedBid` (min / default / max), `bidLimits`, `dailyBudgetLimits.min` (the real floor for this audience).
Default automated bidding (omit `platformSpecificData`). Manual: `platformSpecificData: { "costType": "CPC" | "CPM", "unitCost": 6 }`
inside `bidLimits`. A forecast: `POST /v1/ads/targeting/supply-forecast` (same spec, future window in Unix ms, a budget).

## 5. The ad

- `headline` (required; under 70 characters shows in full, 200 max), `body` = the intro text above the media (150 shows
  before "see more", 600 max).
- Exactly one of `imageUrl` (1200 x 627, JPEG / PNG / GIF, 5 MB) or `video: { "url": ... }` (MP4 H.264, 3 s to 30 min,
  500 MB). Local files: `POST /v1/media` first.
- `callToAction` with `linkUrl` or a lead form: `LEARN_MORE`, `SIGN_UP`, `REQUEST_DEMO`, `DOWNLOAD`, `REGISTER`,
  `SUBSCRIBE`, `APPLY`, `JOIN`, `ATTEND`, `VIEW_QUOTE`, `SEE_MORE`, `SHOP_NOW`, `BUY_NOW`.
- Other formats (carousel, document, event, text ad, spotlight, follower, jobs, conversation, thought-leader) are keys
  inside `platformSpecificData`; see LinkedIn's creative formats in the Creator OS docs.

Full request (`POST /v1/ads/create`):

```json
{
  "accountId": "<acc_>", "adAccountId": "517258773", "organizationId": "urn:li:organization:105959150",
  "name": "Founders · Website visits · 2026-10-01", "goal": "traffic", "budgetAmount": 25, "budgetType": "daily", "endDate": "YYYY-MM-DD",
  "headline": "Run every social account from one place",
  "body": "Your whole social media team in one app. Post, reply and report everywhere.",
  "imageUrl": "https://.../ad-1200x627.jpg",
  "linkUrl": "https://www.example.com/?utm_source=linkedin&utm_medium=paid", "callToAction": "LEARN_MORE",
  "targeting": { "countries": ["US"], "seniorities": ["obj_..."], "industries": ["obj_..."] },
  "status": "PAUSED"
}
```

## 6. Check

The same request with `"validateOnly": true` → `{ valid, checks[], message }`. Fix every `failed`, say every `warning`
out loud, re-check after any change.

## 7. Confirm

Tell the human: the Page, objective and destination, the audience in words and its size, budget, dates and the most it
can spend, the bid, the ad text, paused or live, and that LinkedIn reviews it first. Wait for a clear yes.

## 8. Launch

Same request without `validateOnly`, with an `Idempotency-Key` header (any UUID, reused on a retry). Then the dynamic
UTM `PATCH` from step 2 with the returned ad id.

## 9. Verify

`GET /v1/ads?accountId=<acc_>` → the new ad (`pending_review` at first). Resume a paused one with
`PUT /v1/ads/campaigns/{campaignGroupId}/status { "status": "active", "platform": "linkedin" }`.

## Boost an existing Company Page post

`POST /v1/ads/boost { platformPostId: "urn:li:share:N" (or urn:li:ugcPost:N, from "Copy link to post"; an activity id
won't work), accountId: <acc_>, adAccountId, name, goal: engagement | traffic | awareness | video_views | conversions,
budget: { amount, type: "daily" }, schedule: { startDate, endDate } (date-times), targeting: { countries } }`.
Only Page-authored posts can be sponsored (a personal profile's post answers 422). A post nobody approved for
sponsorship: the Page admin approves it at linkedin.com/sponsorship-permissions. Validate first, same as above.

## Results

- Rolled up: `GET /v1/ads/tree?accountId=<acc_>&platform=linkedin&fromDate=&toDate=` (Campaign Groups → Campaigns →
  ads) and the daily series `GET /v1/ads/timeline?accountId=<acc_>&adAccountId=&fromDate=&toDate=`.
- Who saw it: `GET /v1/ads/campaigns/{campaignGroupId}/analytics?breakdowns=seniority,industry,company_size,job_function,job_title&fromDate=&toDate=`
  (or per ad on `/v1/ads/{adId}/analytics`) → `analytics.breakdowns.<dimension>[]` with `name`, spend, impressions,
  clicks. Totals over the range only, 12 to 24 hours behind, groups under 3 events left out.
- Leads: `GET /v1/ads/leads?accountId=<acc_>` (LinkedIn keeps responses 90 days: export them).
- Conversions: the Insight Tag and its rules on `GET /v1/accounts/<acc_>/tracking-tags` (+ `/{tagId}` for the code and
  rules); server-side events with `POST /v1/ads/conversions`.
