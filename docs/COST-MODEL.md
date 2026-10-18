# Cost model: API keys or a Claude subscription

HSwarm sends work to API-key models (DeepSeek, the Anthropic API, OpenRouter). CliMayte sends it to Claude Code
workers on the owner's Pro, Max 5x and Max 20x subscriptions. `server/src/routing-cost.ts` works out what the same
work costs on each side, for the Routing page's tables. It no longer picks the route (2026-10-13, below). The research
numbers below are a dated snapshot (measured 2026-10-05); the live figures come from `GET /api/routing/cost-model`.

## The research

CliMayte, since 2026-09-28: 1,834 tasks used 19,245.7 % of a Pro 5-hour window and had a list cost of $3,983.53 at
Anthropic's API prices. So one full Pro window holds about $20.70 of work at list price.

A week holds a fixed number of windows, measured from `usage_samples` over 21 days (week-% risen per session-%
risen inside one window): about 11.7 Pro windows on Pro (32 accounts), 9.8 of its own windows on Max 5x (5 accounts)
and 4.1 on Max 20x (2 accounts). A Max 5x window is 4.75 Pro windows, a Max 20x window 19.

At full use over 4.33 weeks a month, Pro ($20) buys about 50.7 Pro windows, about $1,049 at list (1.9 %). Max 5x
($100) buys about 202, about $4,170 (2.4 %). Max 20x ($200) buys about 337, about $6,980 (2.9 %).

So Claude on a subscription is about 34 to 50 times cheaper than the Claude API at list at full use of the plan. DeepSeek flash is 3 to 12 % of
Sonnet's list price, the same order as a subscription, and that is where the split below matters.

## How the numbers are measured

- **Dollars per Pro window** is the sum of CliMayte's `costUsd` over the sum of its `usedPct` / 100 for the last 14
  days (the same figures `GET /api/corch/totals` returns). Under 200 % of a window measured, it falls back to 20.70.
- **Windows per week** is per plan. Per account, over 21 days, the rises of session-% and week-% are summed between
  consecutive samples at most 30 minutes apart in the same session and week window (reset times within 15 minutes).
  Accounts with under 40 session points are dropped. The median of week-rise / session-rise per plan gives
  windows per week as its inverse. A plan with no qualifying account uses 11.7 / 9.8 / 4.1.
- The constants 20.7 (dollars per Pro window) and 11.7 / 9.8 / 4.1 (windows per week) in `routing-cost.ts` are
  fallbacks, used only when there is not enough measured data. Plan sizes (1 / 4.75 / 19) live in `server/src/plans.ts`,
  shared with CliMayte's placement.
- **Effective fraction** of a plan = price / (windows per week x size x 4.33 x dollars per Pro window): what a
  subscription costs as a share of list at full use.
- **Fleet fraction** weights the three plans by how many signed-in CLI instances each has.

## How the route is chosen

Not by price. The subscription costs nothing extra once paid for, so HSwarm sends a task with tools to an idle
CliMayte account first, and to the cheapest API key that meets the task's bar only when no account is idle
(owner, 2026-10-13: the free accounts first when available, then the cheapest key quite certain to finish the job,
paid keys last, Claude and GPT keys only when nothing cheaper can do it). HSwarm reads the idle accounts itself
(`GET /api/corch/capacity`, `hswarm/climayte_route.py`); AgentHydra's routing switch (`routing_enabled`) still turns
it off.

Until then `POST /api/routing/decide` compared the API leg's dollars with the subscription's share of list price and
split close calls by `routing_api_preference_pct` (20) inside a `routing_close_ratio` (3) band. A paid key a little
cheaper than that share won: in the 3 days to 2026-10-13, 46 tool tasks went to API keys by price (35 of them "the API
is more than 3x cheaper") while 16 of the 35 CliMayte accounts sat idle. The endpoint and both settings are gone.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `routing_enabled` | true | Off sends everything to the API. |
| `routing_session_overhead_pct` | 1 | % of a Pro window every subscription task pays to start a session. |
| `routing_discounts` | all 0 | JSON `{ anthropic, deepseek, openrouter, hosted, other }`, percent off list. `hosted` is the paid hosts of open models (Baseten, Together, xAI, OpenAI, Chutes, Fireworks, Moonshot, Nebius, DashScope; `HOSTED_PROVIDERS` in `routing-cost.ts`), `other` the free-tier pools and anything unnamed. |
| `routing_price_pro` / `_max5` / `_max20` | 20 / 100 / 200 | Monthly plan prices in USD. |

The owner's bulk API rate goes into `routing_discounts`: list prices overstate what the owner pays, so enter the
percent off per provider and the Routing page's "your rate" prices drop by it. Since 2026-10-13 that is all they do.
Before, they priced the API side of every routing comparison: `other` and `openrouter` at 100 (the free-tier pools)
kept a free-tier tool task on its key, and `hosted` was split out of `other` on 2026-10-09 because paid Baseten,
Together and xAI legs priced at $0 inside it, so no tool task on them ever went to a subscription.

## Endpoints

- `GET /api/routing/cost-model`: measured numbers with sample sizes and fallback flags, the plan table, a model
  table (Claude and DeepSeek from `hswarm/data/prices.json` through `pricing.ts`) and the settings.
- `PUT /api/routing/settings`: validated and clamped; send any of `enabled`, `sessionOverheadPct`, `discounts`,
  `planPrices`.

## Where to change it

Hydra Desk 2: AgentHydra pane, HSwarm tab, Routing page. Or `PUT /api/routing/settings`. The settings are synced to
the other PC by login sync. The endpoint accepts numbers or numeric strings only: percents are clamped to 0..100,
plan prices to 0..10000. A junk value leaves that field unchanged and the answer is a 400 naming it.

## Forcing a route

- All API: `enabled` false here, or `route_via_climayte = false` in HSwarm's `settings.toml` on one machine.
- Fewer tasks on CliMayte at once: `route_via_climayte_max` in HSwarm's `settings.toml` (unset: as many as are idle).
