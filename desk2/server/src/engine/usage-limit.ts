/** A plan's usage limit as the CLI words it: the usage limit, "hit your limit", the 5-hour or weekly window, a reset time. */
const LIMIT_TEXT =
  /usage limit|hit your (\w+ )?limit|(session|weekly|monthly|opus|sonnet) limit|limit (will )?resets?\b|\bresets? (at |on |in )?(\d|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|tomorrow|midnight|noon)|out of (extra )?usage|(5|five)[- ]hour limit|weekly limit/i
/** What passes in minutes (a per-minute rate limit, an overload) or is no limit of the account at all (the context window). */
const NOT_A_USAGE_LIMIT = /per[- ]minute|requests per|tokens per|\d+ ?seconds?\b|overloaded|context (window|limit|length)/i

/**
 * True for an account's usage limit, the one that holds the account out until its reset and moves an
 * 'auto' chat. A transient 429 or an unrelated "limit reached" is a plain error: the turn can be sent again.
 */
export function isUsageLimitText(text: string): boolean {
  return LIMIT_TEXT.test(text) && !NOT_A_USAGE_LIMIT.test(text)
}
