<script setup lang="ts">
/**
 * AppFooter, the one credit line at the bottom of an app page: the project that
 * maintains this build, linked to its repository (desk2/shared/release-links.ts,
 * held to release-channel.json by tests/release-channel-drift.test.ts). The
 * wording is intentionally literal English (not i18n) so one component serves
 * apps with and without vue-i18n; it lives in src/shell, which every app's i18n
 * prose check exempts. Width tracks the shared `--container-max`.
 *
 * orchestrator/web/src/shell/AppFooter.vue is its twin, with its own copy of the
 * links (orchestrator/web/src/lib/project-links.ts); change both together. Only
 * the twin is shown today, under the orchestrator dashboard: no page of
 * AgentHydra's mounts this copy yet.
 */
import { PROJECT_HOMEPAGE, PROJECT_NAME } from "@desk/shared/release-links";

withDefaults(defineProps<{ name?: string; url?: string }>(), {
  name: PROJECT_NAME,
  url: PROJECT_HOMEPAGE,
});
</script>

<template>
  <footer
    class="mx-auto flex w-full max-w-(--container-max) flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 pb-6 pt-4 text-center text-xs text-muted-foreground/60 sm:px-6"
  >
    <span>
      Maintained by
      <a
        :href="url"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >{{ name }}</a
      >
    </span>
  </footer>
</template>
