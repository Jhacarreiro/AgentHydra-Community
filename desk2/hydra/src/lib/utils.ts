import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge knows Tailwind's own text sizes (and any NNxs/NNxl shape, so 2xs and 3xs) and reads any other text-*
// as a colour: cn() kept one of "text-muted-foreground text-ui", and the select's row variant lost its text-ui size to
// its colour. These are the steps kit-base.css declares (--text-3xs, --text-2xs, --text-ui).
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["3xs", "2xs", "ui"] } } });

/** Standard shadcn-vue class merge helper. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The ONE prefers-reduced-motion read for every kit module (the theme crossfade, the resize-grip
 * reset glide, ...). Keeping the SSR guard, the matchMedia capability check and the policy in a
 * single place stops the copies drifting apart. Stylesheet-level motion is handled separately by
 * the `@media (prefers-reduced-motion: reduce)` block in base.css.
 *
 * Read on every call rather than cached, so a change to the OS setting applies to the next
 * animation without a reload.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}
