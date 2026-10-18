<script setup lang="ts">
// One bar per category, with a line through the moving average of the bars around each one. The bars answer
// "which is biggest"; the line answers "is the run of models around this one better or worse", which a bar on
// its own cannot show. Plain SVG, no chart library: the axis, the legend and the hover value are drawn here.
//
// The labels are model ids, too long to sit under a bar, so they are cut and turned; the full name is in the
// hover value.
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    points: Array<{ key: string; label: string; value: number; detail?: string }>
    /** Bars the trailing average looks across: the bar itself and the window - 1 before it. */
    window?: number
    /** Rendered value on the axis ticks and the hover, e.g. tokens or a percentage. */
    format: (n: number) => string
    barLabel: string
    lineLabel: string
    yTitle: string
    xTitle: string
  }>(),
  { window: 3 },
)

const W = 480
const H = 200
// The top leaves the axis title its own line above the highest tick.
const PAD = { left: 48, right: 10, top: 26, bottom: 64 }
const plotW = W - PAD.left - PAD.right
const plotH = H - PAD.top - PAD.bottom

const hovered = ref<number | null>(null)
const max = computed(() => Math.max(1e-9, ...props.points.map((p) => p.value)))
const slot = computed(() => plotW / Math.max(1, props.points.length))
const x = (i: number) => PAD.left + slot.value * i + slot.value / 2
const y = (v: number) => PAD.top + plotH - (v / max.value) * plotH
// Each bar's trailing average: the bar and the window - 1 bars before it, fewer at the start of the run.
const trend = computed(() =>
  props.points.map((_, i) => {
    const slice = props.points.slice(Math.max(0, i - props.window + 1), i + 1)
    return slice.reduce((sum, p) => sum + p.value, 0) / slice.length
  }),
)
const linePoints = computed(() => trend.value.map((v, i) => `${x(i)},${y(v)}`).join(' '))
// A tick whose label reads like the one below it is left out: when no model failed, one 0% and not three.
const ticks = computed(() =>
  [0, max.value / 2, max.value]
    .map((v) => ({ v, y: y(v), text: props.format(v) }))
    .filter((t, i, all) => all.findIndex((o) => o.text === t.text) === i),
)
const cut = (s: string) => (s.length > 14 ? `${s.slice(0, 13)}…` : s)
</script>

<template>
  <div class="space-y-1.5">
    <div class="relative">
      <svg :viewBox="`0 0 ${W} ${H}`" class="block h-auto w-full" role="img" :aria-label="yTitle">
        <text :x="0" y="10" class="fill-muted-foreground text-2xs">{{ yTitle }}</text>
        <g v-for="tick in ticks" :key="tick.v">
          <line :x1="PAD.left" :x2="W - PAD.right" :y1="tick.y" :y2="tick.y" class="stroke-border" stroke-dasharray="2 3" />
          <text :x="PAD.left - 6" :y="tick.y" dy="0.35em" text-anchor="end" class="fill-muted-foreground text-2xs tabular-nums">{{ tick.text }}</text>
        </g>
        <g v-for="(p, i) in points" :key="p.key">
          <rect
            :x="PAD.left + slot * i + slot * 0.2"
            :y="y(p.value)"
            :width="slot * 0.6"
            :height="Math.max(0.5, PAD.top + plotH - y(p.value))"
            rx="2"
            :style="{ fill: 'var(--viz-seq)' }"
            :opacity="hovered === null || hovered === i ? 1 : 0.45"
          />
          <text
            :transform="`translate(${x(i)},${PAD.top + plotH + 8}) rotate(-35)`"
            text-anchor="end"
            class="fill-muted-foreground text-2xs"
          >{{ cut(p.label) }}</text>
          <rect
            :x="PAD.left + slot * i"
            :y="PAD.top"
            :width="slot"
            :height="plotH"
            fill="transparent"
            @mouseenter="hovered = i"
            @mouseleave="hovered = null"
          />
        </g>
        <polyline :points="linePoints" fill="none" class="stroke-foreground" stroke-width="1.5" stroke-linejoin="round" />
        <circle
          v-for="(v, i) in trend"
          :key="`t${i}`"
          :cx="x(i)"
          :cy="y(v)"
          r="2"
          class="fill-foreground"
          :opacity="hovered === null || hovered === i ? 1 : 0.45"
        />
      </svg>
      <div
        v-if="hovered !== null && points[hovered]"
        class="pointer-events-none absolute top-0 z-10 w-max max-w-56 -translate-x-1/2 rounded-md bg-popover px-2 py-1 text-2xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
        :style="{ left: `${(x(hovered) / W) * 100}%` }"
      >
        <div class="font-medium break-all">{{ points[hovered].label }}</div>
        <div class="tabular-nums">{{ yTitle }}: {{ format(points[hovered].value) }}</div>
        <div class="tabular-nums text-muted-foreground">{{ lineLabel }}: {{ format(trend[hovered]) }}</div>
        <div v-if="points[hovered].detail" class="text-muted-foreground">{{ points[hovered].detail }}</div>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
      <span class="flex items-center gap-1"><span class="size-2 rounded-sm" :style="{ background: 'var(--viz-seq)' }"></span>{{ barLabel }}</span>
      <span class="flex items-center gap-1"><span class="h-0.5 w-3 bg-foreground"></span>{{ lineLabel }}</span>
      <span>{{ xTitle }}</span>
    </div>
  </div>
</template>
