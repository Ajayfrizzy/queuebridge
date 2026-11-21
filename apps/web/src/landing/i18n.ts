import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './locales/en.js';

/**
 * M7.2 localization (REQ-F15.3.5): an i18next instance for the landing page, English baseline.
 * Created inside the landing chunk only, so visitor and staff routes never download i18next.
 * Resources are bundled (no network request), initialized synchronously, and React escapes
 * interpolated values itself. A missing key renders the key, which the tests treat as a failure.
 */
export const LANDING_NS = 'landing';

export function createLandingI18n(resources: { en: object } = { en }, lng = 'en'): I18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    supportedLngs: Object.keys(resources),
    ns: [LANDING_NS],
    defaultNS: LANDING_NS,
    resources: Object.fromEntries(
      Object.entries(resources).map(([l, r]) => [l, { [LANDING_NS]: r }]),
    ),
    initAsync: false,
    returnObjects: true,
    interpolation: { escapeValue: false },
  });
  return instance;
}
