import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Hero composition (CSS/SVG, design tokens): a ticket crossing the bridge from a phone to a
 * counter, with a "Confirmed" sync badge. One short entrance (under a second, runs once); no loop,
 * so no pause control is needed; static under reduced motion.
 */
export function HeroArt(): ReactElement {
  const { t } = useTranslation();
  return (
    <svg className="hero-art" viewBox="0 0 360 260" role="img" aria-label={t('hero.artLabel')}>
      <defs>
        <linearGradient id="qb-hero-glow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="ha-stop-a" />
          <stop offset="1" className="ha-stop-b" />
        </linearGradient>
      </defs>
      <circle cx="250" cy="90" r="80" fill="url(#qb-hero-glow)" className="ha-glow" />
      {/* bridge */}
      <path d="M20 200 Q 180 90 340 200" className="ha-cable" />
      <path d="M20 214 H 340" className="ha-deck" />
      <path d="M110 214 V 146 M250 214 V 146" className="ha-tower" />
      {/* phone */}
      <g transform="translate(24 104)">
        <rect width="70" height="108" rx="12" className="ha-device" />
        <rect x="8" y="12" width="54" height="78" rx="5" className="ha-screen" />
        <rect x="16" y="24" width="38" height="8" rx="4" className="ha-bar" />
        <rect x="16" y="40" width="26" height="8" rx="4" className="ha-bar ha-bar-muted" />
      </g>
      {/* counter */}
      <g transform="translate(268 132)">
        <rect width="80" height="70" rx="10" className="ha-device" />
        <text x="40" y="42" textAnchor="middle" className="ha-counter">
          {t('hero.artCounter')}
        </text>
      </g>
      {/* ticket crossing */}
      <g className="ha-ticket">
        <g transform="translate(140 96)">
          <rect width="96" height="58" rx="10" className="ha-ticket-card" />
          <text x="14" y="22" className="ha-ticket-label">
            {t('hero.artTicket')}
          </text>
          <text x="14" y="46" className="ha-ticket-code">
            G014
          </text>
        </g>
        <g transform="translate(208 80)">
          <rect width="92" height="26" rx="13" className="ha-badge" />
          <path d="M12 13 l4 4 l8 -9" className="ha-tick" />
          <text x="30" y="18" className="ha-badge-text">
            {t('hero.artConfirmed')}
          </text>
        </g>
      </g>
    </svg>
  );
}
