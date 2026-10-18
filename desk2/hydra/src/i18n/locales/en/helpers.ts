// The header's always-on helpers chip (HelpersStatus.vue): the background servers and watchers the
// daemon keeps running from the owner's helpers.json.
export default {
  chip: '{n} helpers · {memory}',
  chipDown: '{n} down',
  chipStopped: 'Helpers stopped',
  title: 'Always-on helpers',
  tooltip: 'The background servers and watchers AgentHydra keeps running. Click to see each one.',
  restart: 'Restart {name}',
  stopAll: 'Stop all',
  startAll: 'Start all',
  stoppedToast: 'Every helper stopped. None starts until you start them again.',
  undo: 'Undo',
  starting: 'Starting',
  waiting: 'Waiting to try again',
  stopped: 'Stopped',
  managed: 'Runs from its own setting',
  configError: 'helpers.json: {error}',
  failed: 'Could not reach the daemon: {reason}',
}
