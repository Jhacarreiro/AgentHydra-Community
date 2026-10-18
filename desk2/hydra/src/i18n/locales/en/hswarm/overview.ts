// Strings for the HSwarm tab's overview view (components/hswarm/HSwarmOverview.vue).
export default {
  // Lead text
  freshLead:
    'HSwarm lets your AI coding assistant hand busywork to cheaper AI models, many at once, so big jobs cost less and finish sooner. Add one API key to start: Gemini, Groq and Cerebras have free tiers.',
  lead: "What this machine's swarm can run on right now. Nothing here makes a model call unless you press Test, Probe or Ask.",

  // Stat tiles
  liveProviders: 'Live providers',
  withReadyKey: 'with a ready key',
  noReadyKey: 'none has a ready key yet',

  readyKeys: 'Ready keys',
  allUsable: 'all usable now',
  noKeysYet: 'no keys yet',

  starredModels: 'Starred models',
  model: 'model',
  models: 'models',
  usableNow: 'usable now',

  spend14Days: 'Tokens, 14 days',
  loading: 'loading…',
  nothingRun: 'nothing has run yet',
  loadFailed: 'could not load',
  task: 'task',
  tasks: 'tasks',
  of: 'of',
  resting: 'resting',
  auto: 'AUTO',

  // Getting started
  gettingStarted: 'Getting started',
  addKey: 'Add an API key',
  addKeyDesc:
    "An API key is a code, like a password, that lets you use a provider's models. Get one on the provider's site and paste it here; it stays on this computer.",
  action0: 'Add a key',

  selectModels: 'Let HSwarm pick the models',
  selectModelsDesc:
    "It picks, for each task, the cheapest model that scored well enough on published tests. A provider's models join in once it has a key.",
  action1: 'See the models',

  connectAssistant: 'Connect your assistant',
  connectAssistantDesc:
    'Tell Claude Code, Claude Desktop or Codex that HSwarm is here, in one click.',
  action2: 'Connect Claude Code',

  // Charts
  spendChart: 'Tokens, last 14 days',
  showNumbers: 'Show the numbers',
  tokensIn14Days: 'tokens in 14 days',
  cachedInput: 'of it cached input',
  tokensUsed: '{n} used',
  tokens: 'Tokens',
  day: 'Day',
  cost: 'Value at list price',
  errors: 'Errors',
  separator: '·',
  timeUnit: 's',

  outcomeChart: 'Failed tasks, share per day',
  taskFailureRate: "Share of the day's tasks that failed",

  noSpendTitle: 'No tokens yet',
  noSpendBody: 'Every task the swarm runs is counted here, per day',
  noTasksTitle: 'No tasks yet',
  noTasksBody: 'Finished tasks show up here per day, ok or failed',

  keyHealth: 'Key health by provider',
  moneyChart: 'Tokens by provider (14 days)',
  climayteTitle: 'CliMayte',
  shortfall:
    '{turned} tasks went to paid keys today with every account busy; {more} more {kind} account would have taken {took} | {turned} tasks went to paid keys today with every account busy; {more} more {kind} accounts would have taken {took}',
  shortfallKind: { chatgpt: 'Free ChatGPT', claude: 'Free Claude', climayte: 'CliMayte' },
  climayteCaption: 'What the tasks handed to CliMayte offloaded, and which models pass each kind of task.',
  chartsEmpty:
    'Tokens, failures and key health are charted here once you have a key and the swarm has run a task.',

  results: {
    title: 'Model results',
    days: 'Last {n} days',
    all: 'All',
    failed: 'Could not load model results:',
    emptyTitle: 'No finished tasks in this window',
    emptyBody:
      'Thumbs up and down, cost and edit survival per model appear once the swarm has run tasks.',
    sources: { both: 'Both', hswarm: 'HSwarm', climayte: 'CliMayte' },
    sourceTag: { hswarm: 'HSwarm', climayte: 'CliMayte' },
    outcomes: 'Thumbs up and down',
    outcomesCaption:
      'HSwarm rows: up is a task that got an answer, down is an error or timeout; the % is the answer rate, not correctness. CliMayte rows: up passed its check, the wrench is a pass after a small fix or rework, down failed; the % is the score (pass 1, small fix 2/3, rework 1/3), the number routing uses. Busiest first. CliMayte follows the range chosen above.',
    hswarmPctHint: 'Share of tasks that got an answer. It does not say the answer was right.',
    fixed: 'fixed',
    tokensEstimated: 'tokens estimated (Free routes report none)',
    noRows: 'No model has finished tasks for this source.',
    climayteMissing: "CliMayte's scorecard is not available right now.",
    upDown: '{up} up · {down} down',
    up: 'up',
    down: 'down',
    trend: '3-model average',
    tokensAxis: 'Tokens',
    failedAxis: '% failed',
    modelAxis: 'Model, best first',
    tokensPerOk: 'Tokens per success',
    tokensCaption:
      "Input and output tokens of a model's tasks, divided by its successes. Cache reads and writes are left out. Free models count tokens by estimate. Fewest first; the line averages three bars. A model with fewer than 5 successes is marked and listed last.",
    tokensHswarmOnly: 'Tokens come from HSwarm only. CliMayte keeps no token count per model.',
    noOk: 'No model has a successful task yet.',
    noTokens: '{n} models with successes recorded no tokens and are left out.',
    failedShare: 'Failed share',
    failedCaption:
      'Failed tasks as a share of all of a model\'s tasks. Lowest first; the line averages three bars. Fewer than 5 tasks is marked and listed last.',
    few: 'few',
    fewTasks: 'Under {n} successes or tasks, so the number can swing on one task',
    survival: 'Kept after 1 day',
    survivalCaption:
      "Share of a model's added code still in the repo a day later, from HSwarm's scoring. Models with no scored edits are left out.",
    noSurvival: 'No model has scored edits yet. Edits are scored after a day.',
    scored: '{n} scored tasks',
    perDay: 'Tasks per day',
    perDayCaption: "Tasks per model on each day, busiest models named. All shows the last 30 days.",
    other: 'other',
    showMore: 'Show more',
    showLess: 'Show less',
  },

  // Health section
  health: 'Health',
  doctor: 'Doctor',
  doctorDesc: 'Checks keys, binaries and the model registry without spending anything.',
  runDoctor: 'Run doctor',
  running: 'Running…',

  balances: 'Balances',
  balancesDesc: 'Free: asks each provider for its balance and wakes keys that were topped up.',
  probeBalances: 'Probe every balance',

  // Quick ask
  quickAsk: 'Quick ask',
  askPlaceholder: 'Ask the swarm one tool-free question…',
  autoCheapest: 'auto (cheapest that qualifies)',
  ask: 'Ask',
  noAnswer: 'The question got no answer. The server said:',
}
