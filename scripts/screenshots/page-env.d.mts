// Types for page-env.mjs, which the tests import.
export declare const SHOT_CLOCK: number
export declare const SHOT_TIMEZONE: string
export declare const SHOT_LOCALE: string
export declare function installClock(fixedMs: number): void
export declare const clockScript: string
export declare const windowFontCss: string
export declare const stillCss: string
export declare function styleScript(css: string): string
export declare const SHOT_FONT_DIR: string
export declare function privateFindings(text: string): string[]
export declare const privacyScript: string
export declare function chromeArgs(): string[]
export declare function resolveChrome(): { path: string; from: 'CHROME_PATH' | 'PUPPETEER_EXECUTABLE_PATH' | 'puppeteer' | 'system' }
export declare function chromeVersion(path: string): string
export declare function pngSize(file: string): { width: number; height: number } | null
