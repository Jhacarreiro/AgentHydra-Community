export type SignalLabel =
  | 'praise'
  | 'correction'
  | 'complaint'
  | 'repeat'
  | 'keep_going'
  | 'status_ask'
  | 'new_ask'

export interface Classified {
  label: SignalLabel
  rule: string
}

// Ported from ~/.claude/tools/chat-audit/friction_scan.py, plus PRAISE.
const FRUST =
  /\b(fuck|fucking|shit|wtf|damn|god damn|goddamn|bullshit|stupid|idiot|dumb|useless|jesus|christ|hell)\b/i
const CORRECT =
  /\b(no[,.! ]|not what i (asked|said|meant|want)|i (already )?(said|told you|asked)|again\b|why did you|why didn't you|you didn't|you did not|stop (doing|saying|asking)|don'?t (do|say|ask) that|wrong|that'?s not|i never said|listen|read (what|my)|didn'?t i|how many times)\b/i
const CONTINUE =
  /^(continue|go|go on|keep going|proceed|yes|yep|yeah|ok|okay|do it|ok do it|sure|next|and\?|\.\.\.|k|y|finish|finish it|carry on|resume|done\?|and then\?|so\?|\?)[.!?\s]*$/i
const ASK_STATUS =
  /\b(are you done|is it done|did (you|it) (finish|work|deploy)|what happened|where are you|status\??|still working|you there|hello\??)\b/i
const PLEASE_REPEAT =
  /\b(as i said|like i said|i keep|for the (second|third|\d+th) time|once again|yet again|every single time|same thing)\b/i
const PRAISE = /\b(thanks|thank you|great|perfect|nice|love it|awesome|good job)\b/i

const REPEAT_JACCARD = 0.7
const REPEAT_MIN_TOKENS = 5

function tokens(text: string): Set<string> {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return new Set(norm ? norm.split(' ') : [])
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** The class of an owner or parent message, from its text alone; the text is not stored. */
export function classify(text: string, prior: string[]): Classified {
  const t = text.trim()
  if (FRUST.test(t)) return { label: 'complaint', rule: 'FRUST' }
  if (CORRECT.test(t)) return { label: 'correction', rule: 'CORRECT' }
  if (PLEASE_REPEAT.test(t)) return { label: 'repeat', rule: 'PLEASE_REPEAT' }
  const mine = tokens(t)
  if (
    mine.size >= REPEAT_MIN_TOKENS &&
    prior.some((p) => jaccard(mine, tokens(p)) >= REPEAT_JACCARD)
  ) {
    return { label: 'repeat', rule: 'JACCARD' }
  }
  if (ASK_STATUS.test(t)) return { label: 'status_ask', rule: 'ASK_STATUS' }
  if (CONTINUE.test(t)) return { label: 'keep_going', rule: 'CONTINUE' }
  if (PRAISE.test(t)) return { label: 'praise', rule: 'PRAISE' }
  return { label: 'new_ask', rule: 'NEW_ASK' }
}
