import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge knows Tailwind's own text sizes (and any NNxs/NNxl shape) and reads any other text-* as a colour, so
// cn() kept one of "text-text-muted text-ui" and the colour was lost. These are the steps style.css declares
// (--text-3xs .. --text-ui-lg).
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["3xs", "2xs", "ui-sm", "ui", "ui-lg"] } } });

/** Standard shadcn-vue class merge helper (copied from AgentHydra's web/src/lib/utils.ts). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
