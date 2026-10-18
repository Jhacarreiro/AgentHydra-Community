import { describe, expect, test } from 'bun:test'
import { classify, type SignalLabel } from '../../src/manager-analytics/signal'

describe('classify', () => {
  test.each([
    ['this is broken, fucking fix it', 'complaint', 'FRUST'],
    ['no, that is not what i asked for', 'correction', 'CORRECT'],
    ['every single time the sidebar breaks', 'repeat', 'PLEASE_REPEAT'],
    ['are you done yet?', 'status_ask', 'ASK_STATUS'],
    ['continue', 'keep_going', 'CONTINUE'],
    ['thanks, that is perfect', 'praise', 'PRAISE'],
    ['draft a summary of the quarterly ledger', 'new_ask', 'NEW_ASK'],
  ])('%s is %s', (text, label, rule) => {
    expect(classify(text, [])).toEqual({ label: label as SignalLabel, rule })
  })

  test('a near-copy of an earlier owner message is a repeat', () => {
    const prior = ['please rename the sidebar header to show the manager name']
    expect(classify('please rename the sidebar header to show the manager name', prior)).toEqual({
      label: 'repeat',
      rule: 'JACCARD',
    })
  })

  test('a short near-copy is not a repeat', () => {
    expect(classify('rename header', ['rename header'])).toEqual({
      label: 'new_ask',
      rule: 'NEW_ASK',
    })
  })
})
