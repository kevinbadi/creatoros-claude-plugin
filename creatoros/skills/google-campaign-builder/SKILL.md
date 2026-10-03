---
name: google-campaign-builder
description: Build and launch a Google Ads campaign end to end through the Creator OS API - Search (keywords with Keyword Planner research, 3-15 headlines, 2-4 descriptions), Display (two images) or Performance Max (an asset group), locations, a daily budget, Google's own dry run, the human's confirmation, launch and a status check - plus the weekly optimization loop (search terms, keywords and quality score, Google's recommendations, GAQL reports). Use when asked to create, launch, plan or optimize Google Ads, search ads, display ads or Performance Max. Needs the Creator OS Ads add-on and a connected Google Ads account.
version: 1
---

# Google campaign builder

The same pipeline as the Create campaign wizard on the Google Ads page of the Creator OS web app, for an agent:
**Account → Type → Goal + URL → Locations → Keywords (Search) → Ad → Budget → Check → Confirm → Launch → Verify**, then **Optimize**.
Nothing is created until step 10.

## How to call the API

- Base URL: `$CREATOROS_API_URL`, default `https://creatoros-production-5658.up.railway.app`.
  Every call sends `Authorization: Bearer $CREATOROS_API_KEY` (a `cos_live_` key, pinned to one workspace).
- Same calls through the other surfaces:
  - CLI: `creatoros ads:call <METHOD> <path> [--query '{...}'] [--body '{...}']`.
  - MCP: `ads_list_connections`, `ads_list_ad_accounts`, `ads_create_ad`, `ads_google_keyword_ideas`, `ads_google_keywords`,
    `ads_google_search_terms`, `ads_google_recommendations`, `ads_set_status`, `ads_update_budget`; `ads_read` / `ads_request` for anything else.
- Errors are `{ "error": { "code", "message", "status" } }`. `ads_addon_required` (402): the Ads add-on is off; it's
  $19.99/month on the Ads page of the web app. Stop.
- **Money is whole units of the account currency** on create and budgets (`20` = $20.00). Google's own reports
  (GAQL, Keyword Planner, search terms) are in **micros**: divide by 1,000,000.
- Live Google calls (GAQL, search terms, Keyword Planner, keyword and recommendation writes) share a burst limit of
  15 a minute per user. A `429` with `details.quotaExhausted` means wait until `details.resetsAt`.

## Money rules (never break these)

- A campaign spends the human's real money. Show the plan (step 9) and get an explicit yes before launching, unless a
  standing instruction says otherwise, and then stay inside its limits.
- Create paused (`status: "PAUSED"`) unless the human wants it live right away. Performance Max is always created paused.
- Applying a Google recommendation changes the account and can't be undone: read it to the human and get a yes first.

## 1. Account

`GET /v1/ads/connections` → the connection with `network: "google"` (its `id` is `accountId`).
`GET /v1/ads/accounts?accountId=<acc_>` → customer accounts (`adAccountId` = the 10-digit customer id, no dashes). One
login can reach several (and accounts under an MCC): ask which one when there are several.
No connection: `GET /v1/connect/google/ads?return_to=https://www.creatoros.ca/app/ads/google` and give the human the `auth_url`.

## 2. Type

| `campaignType` | Use it for | Creative |
|---|---|---|
| `search` | people already searching for what you sell (highest intent) | text: headlines + descriptions + keywords |
| `display` | reach and retargeting across sites and apps | headline, long headline, description, business name, 2 images |
| `pmax` | conversions everywhere Google serves (needs conversion tracking to be worth it) | an asset group |

Demand Gen (`demand_gen`, YouTube / Discover / Gmail) also works on `/v1/ads/create`; Shopping and Video can't be created here.

## 3. Goal and URL

`goal`: `traffic` (clicks; the usual), `awareness` (impressions) or `engagement`. Conversion goals and `video_views` are
refused at create; Performance Max takes no goal (it bids for conversions). `linkUrl` is the final URL.
Tracking: append `utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}` to the URL (Google
fills `{campaignid}` and `{keyword}` on click). Campaign-level templates: `GET/PATCH /v1/ads/{adId}/tracking-tags`
(`trackingUrlTemplate`, `finalUrlSuffix`).

## 4. Locations

`countries` (ISO codes) and `locationTargetingType`: `presence` (people in the places; recommended) or
`presence_or_interest` (Google's default, also people searching about them).

## 5. Keywords (Search only)

Research before choosing:
`POST /v1/ads/keywords/ideas { accountId, customerId, seedKeywords: [...], seedUrl, countries }` → `data[].text` with
`keywordIdeaMetrics.avgMonthlySearches` (string), `competition`, `low/highTopOfPageBidMicros`. Pick 5 to 20 tightly
related keywords with real volume and a bid range the budget can afford (a $20/day budget at a $5 click is 4 clicks a day).
`keywords` on create: strings (broad match) or `{ "text": "...", "matchType": "phrase" | "exact" | "broad" }`. Phrase
match is a good default. 80 characters each.

## 6. The ad

- **Search**: `headline` + `additionalHeadlines` = 3 to 15 distinct headlines of 30 characters; `body` +
  `additionalDescriptions` = 2 to 4 descriptions of 90. Write 8 to 15 headlines (benefits, the brand, an offer, a call
  to action, the main keyword). Pin with `{ "text": "...", "pinnedField": "HEADLINE_1" }` only when you must.
- **Display**: `headline` (30), `longHeadline` (90, defaults to headline), `body` (90), `businessName` (25),
  `images: { landscape: <1.91:1 URL>, square: <1:1 URL> }` (both required; JPEG / PNG, 5 MB).
- **Performance Max**: `assetGroup: { businessName, finalUrl, longHeadline, headlines: [3-5], descriptions: [2-5],
  images: { landscape: [url], square: [url], logo: [url] }, youtubeVideoId? }`; no `headline` / `body` / `linkUrl`.
- Local images: `POST /v1/media` (raw body) and use the returned URL.

## 7. Budget

`budgetAmount` + `budgetType: "daily"` (Performance Max: daily only), optional `endDate`. Google may spend up to 2x on a
busy day but not more than 30.4x the daily budget in a month.

## 8. Check

Send the full request to `POST /v1/ads/create` with `"validateOnly": true`. Creator OS checks the rules above first; if
they pass, Google runs the whole campaign in its own dry run (`checked_by: "network"`). Fix every `failed`, read every
`warning` out loud, re-check after any change.

Full Search request:

```json
{
  "accountId": "<acc_>", "adAccountId": "1234567890", "campaignType": "search", "name": "Search · scheduler · 2026-10-01",
  "goal": "traffic", "budgetAmount": 20, "budgetType": "daily",
  "countries": ["US"], "locationTargetingType": "presence",
  "linkUrl": "https://www.example.com/?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}",
  "headline": "Creator OS", "additionalHeadlines": ["Run Every Social in One App", "Free 7-Day Trial", "..."],
  "body": "Post, schedule and reply on every platform from one place.", "additionalDescriptions": ["..."],
  "keywords": [{ "text": "social media scheduler", "matchType": "phrase" }],
  "status": "PAUSED"
}
```

## 9. Confirm

Tell the human: type, keywords (and their search volume / bid range), the ad text, locations, daily budget and the
monthly ceiling (30.4 x daily), paused or live. Google reviews ads (usually within a business day). Wait for a clear yes.

## 10. Launch

Same request without `validateOnly`, with an `Idempotency-Key` header (any UUID, reused on a retry). Never retry without it.

## 11. Verify

`GET /v1/ads?accountId=<acc_>` → the new ad, `status: pending_review` at first. Turn a paused campaign on with
`PUT /v1/ads/campaigns/{campaignId}/status { "status": "active", "platform": "google" }` once the human says so.

## Optimize (weekly)

1. **Results**: `GET /v1/ads/tree?accountId=<acc_>&platform=google&fromDate=&toDate=` (campaign / ad group / ad metrics),
   or any GAQL: `GET /v1/ads/insights?accountId=<acc_>&customerId=<id>&query=SELECT campaign.name, metrics.clicks,
   metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS` (read-only; a
   `segments.date` select needs a finite range).
2. **Search terms**: `GET /v1/ads/search-terms?accountId=<acc_>&customerId=<id>` → what people typed, by cost.
   Irrelevant terms with spend and no conversions → negatives
   (`PUT /v1/ads/campaigns/{campaignId}/negative-keywords { "keywords": [...] }` replaces the campaign's list;
   `POST /v1/ads/keywords { accountId, adSetId, keywords, negative: true }` adds ad-group negatives). Good terms not
   yet keywords (`status: NONE`) → `POST /v1/ads/keywords { accountId, adSetId, keywords: [{ text, matchType }] }`.
3. **Keywords**: `GET /v1/ads/keywords?accountId=<acc_>` → quality score 1-10 and 30-day results. Pause keywords that
   spend without converting: `PATCH /v1/ads/keywords/{id} { "status": "paused" }`.
4. **Recommendations**: `GET /v1/ads/recommendations?accountId=<acc_>&adAccountId=<id>` → `type`, `impact.base` vs
   `impact.potential`. Recommend, don't auto-apply: Google optimizes for Google too. On a yes:
   `POST /v1/ads/recommendations/apply { accountId, adAccountId, recommendations: [{ resourceName }] }`; otherwise
   `/dismiss { accountId, adAccountId, resourceNames }`. Check each item's `status` in `results`.
5. **Ad text**: `PUT /v1/ads/{adId} { headlines, descriptions, finalUrls }` replaces a Search ad's lists in full.
6. **Budget**: `PUT /v1/ads/campaigns/{campaignId} { "platform": "google", "budget": { "amount": 30, "type": "daily" } }`
   (a shared budget needs `allowSharedBudgetUpdate: true`).
