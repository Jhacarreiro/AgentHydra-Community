// The cost routing section of HSwarm's Routing page (components/hswarm/HSwarmCostRouting.vue): API keys
// or subscriptions.
export default {
  title: 'API keys or subscriptions',
  subtitle:
    'A task that reads or edits files runs on an idle CliMayte account first. The costs below show what each route would cost.',
  loadFailed: 'Could not load the cost model',
  saveFailed: 'Could not save: {reason}',
  saving: 'Saving…',
  enabled: 'Routing',
  enabledNote:
    'When this is on, an HSwarm task that reads or edits files goes to an idle CliMayte account first, since the subscription costs nothing extra; with no idle account it runs on the cheapest API key that meets its bar. Paid Claude and GPT keys come last.',
  discountsTitle: 'Bulk-rate discount',
  discountsNote:
    'Percent off list prices that you pay per provider; it lowers the "your rate" prices below. A free-tier key is 100% off. It no longer decides where a task runs.',
  discountAnthropic: 'Anthropic',
  discountDeepseek: 'DeepSeek',
  discountOpenrouter: 'OpenRouter',
  discountHosted: 'Paid hosts',
  discountOther: 'Free tiers',
  plansTitle: 'Plans',
  colPlan: 'Plan',
  colPrice: 'Price a month',
  colWindows: '5-hour windows a week',
  colWork: 'Work per window (list)',
  colEffective: 'Effective % of list',
  measured: 'measured, {n} accounts',
  fellBack: 'default',
  modelsTitle: 'Models, $ per million tokens (in / out)',
  colModel: 'Model',
  colList: 'List',
  colYours: 'Your rate',
  colSubscription: 'Subscription',
  cheapest: 'Cheapest',
  asOf: 'Prices as of {date}.',
}
