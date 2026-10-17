import { createAppI18n } from '@/lib/i18n-core'
import en from './locales/en'

// The vue-i18n bootstrap — locale persistence (under `agenthydra.locale`), the <html lang>
// sync, and the supported-locale set — lives in the shared factory (@/lib/i18n-core), the same
// file orchestrator/web uses. English is the base; add more catalogs under ./locales.
const app = createAppI18n({ en }, 'agenthydra.locale')
export const i18n = app.i18n
export const setLocale = app.setLocale
export const t = app.t
