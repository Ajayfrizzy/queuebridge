import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The continuity story as a miniature QueueBridge workflow (CSS/SVG, local to the landing chunk).
 *
 * One persistent drawing: the visitor's ticket page (left), the server and its connection
 * (top), and the designated coordinator's console (right). The stage is a `data-stage`
 * attribute; every change between stages is a CSS transition of opacity or transform, so the
 * same ticket, rows and badges visibly change state instead of being redrawn.
 *
 * Truthfulness, drawn as well as written:
 * - offline actions on the console are dashed and labelled "Local only"; the visitor's page keeps
 *   showing the last confirmed state and says it is not updating;
 * - after reconnection one action is "Synced" and one stays "Needs review" until the end: a
 *   conflict does not disappear by itself;
 * - "It's your turn" appears on the visitor's page only in the last stage, after the server is
 *   back and the call is committed (shown "Synced").
 *
 * The SVG is one labelled image; the written caption carries the meaning (REQ-F15.4.2).
 */
export function StoryScene({
  stage,
  title,
  playing = false,
}: {
  stage: number;
  title: string;
  playing?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const s = (k: string): string => t(`story.sim.${k}`);
  return (
    <svg
      className="story-scene sim"
      data-stage={stage}
      data-playing={playing ? 'true' : 'false'}
      viewBox="0 0 400 250"
      role="img"
      aria-label={t('story.sceneLabel', { n: stage, title })}
      focusable="false"
    >
      {/* ---- bridge baseline (brand) ---- */}
      <path d="M8 244 Q 200 206 392 244" className="sim-bridge" />

      {/* ---- server and connection ---- */}
      <g transform="translate(168 8)">
        <rect width="64" height="40" rx="10" className="sim-server" />
        <rect x="12" y="11" width="40" height="5" rx="2.5" className="sim-server-line" />
        <rect x="12" y="22" width="28" height="5" rx="2.5" className="sim-server-line" />
      </g>
      <g className="sim-net">
        <g className="sim-on">
          <rect x="160" y="54" width="80" height="20" rx="10" className="sim-pill sim-pill-ok" />
          <text x="200" y="68" textAnchor="middle" className="sim-pill-text">
            {s('online')}
          </text>
        </g>
        <g className="sim-off">
          <rect x="160" y="54" width="80" height="20" rx="10" className="sim-pill sim-pill-off" />
          <text x="200" y="68" textAnchor="middle" className="sim-pill-text">
            {s('offline')}
          </text>
        </g>
        <g className="sim-sync">
          <rect x="160" y="54" width="80" height="20" rx="10" className="sim-pill sim-pill-sync" />
          <text x="200" y="68" textAnchor="middle" className="sim-pill-text">
            {s('syncing')}
          </text>
        </g>
      </g>
      {/* links: solid while connected, faint dashed while offline (crossfaded) */}
      <path d="M86 84 C 110 50, 140 30, 166 28" className="sim-link sim-link-live" />
      <path d="M314 96 C 290 50, 260 30, 234 28" className="sim-link sim-link-live" />
      <path d="M86 84 C 110 50, 140 30, 166 28" className="sim-link sim-link-down" />
      <path d="M314 96 C 290 50, 260 30, 234 28" className="sim-link sim-link-down" />
      {/* sync packets travel from the console to the server while reconnecting */}
      <g className="sim-packets">
        <circle r="4" className="sim-packet sim-packet-1" />
        <circle r="4" className="sim-packet sim-packet-2" />
      </g>
      {/* the committed call travels from the server to the visitor */}
      <circle r="5" className="sim-call" />

      {/* ---- visitor ticket page ---- */}
      <g transform="translate(22 84)">
        <rect width="112" height="146" rx="14" className="sim-device" />
        <rect x="8" y="10" width="96" height="126" rx="8" className="sim-screen" />
        <text x="16" y="28" className="sim-label">
          {s('visitor')}
        </text>
        {/* the ticket: the focal point */}
        <g className="sim-ticket">
          <rect x="14" y="36" width="84" height="44" rx="8" className="sim-ticket-card" />
          <text x="56" y="66" textAnchor="middle" className="sim-ticket-code">
            G014
          </text>
        </g>
        {/* status lines, one per state, crossfaded */}
        <g className="sim-v sim-v-joined">
          <text x="16" y="100" className="sim-status">
            {s('joined')}
          </text>
          <text x="16" y="116" className="sim-ok-text">
            ✓ {s('confirmed')}
          </text>
        </g>
        <g className="sim-v sim-v-waiting">
          <text x="16" y="100" className="sim-status">
            {s('ahead')}
          </text>
          <rect x="16" y="108" width="80" height="6" rx="3" className="sim-range" />
          <rect x="30" y="108" width="34" height="6" rx="3" className="sim-range-fill" />
          <text x="16" y="128" className="sim-muted">
            {s('range')}
          </text>
        </g>
        <g className="sim-v sim-v-stale">
          <text x="16" y="100" className="sim-status">
            {s('ahead')}
          </text>
          <text x="16" y="116" className="sim-warn-text">
            {s('notUpdating')}
          </text>
          <text x="16" y="128" className="sim-muted">
            {s('lastConfirmed')}
          </text>
        </g>
        <g className="sim-v sim-v-checking">
          <text x="16" y="100" className="sim-status">
            {s('ahead')}
          </text>
          <text x="16" y="116" className="sim-muted">
            {s('checking')}
          </text>
        </g>
        <g className="sim-v sim-v-turn">
          <rect x="10" y="88" width="92" height="42" rx="8" className="sim-turn" />
          <text x="56" y="106" textAnchor="middle" className="sim-turn-title">
            {s('yourTurn')}
          </text>
          <text x="56" y="122" textAnchor="middle" className="sim-turn-sub">
            {s('counter')}
          </text>
        </g>
      </g>

      {/* ---- coordinator console ---- */}
      <g transform="translate(232 96)">
        <rect width="156" height="134" rx="14" className="sim-device" />
        <rect x="8" y="10" width="140" height="114" rx="8" className="sim-screen" />
        <text x="16" y="28" className="sim-label">
          {s('coordinator')}
        </text>
        {/* G012 */}
        <g transform="translate(14 38)">
          <rect width="128" height="24" rx="6" className="sim-row" />
          <rect width="128" height="24" rx="6" className="sim-row-local sim-r12-local" />
          <rect width="128" height="24" rx="6" className="sim-row-review sim-r12-review" />
          <text x="8" y="16" className="sim-row-code">
            G012
          </text>
          <text x="120" y="16" textAnchor="end" className="sim-row-state sim-r12-serving">
            {s('serving')}
          </text>
          <text
            x="120"
            y="16"
            textAnchor="end"
            className="sim-row-state sim-warn-text sim-r12-done"
          >
            {s('localOnly')}
          </text>
          <text x="120" y="16" textAnchor="end" className="sim-row-state sim-warn-text sim-r12-rev">
            ! {s('review')}
          </text>
        </g>
        {/* G013 */}
        <g transform="translate(14 66)">
          <rect width="128" height="24" rx="6" className="sim-row" />
          <rect width="128" height="24" rx="6" className="sim-row-local sim-r13-local" />
          <text x="8" y="16" className="sim-row-code">
            G013
          </text>
          <text x="120" y="16" textAnchor="end" className="sim-row-state sim-r13-wait">
            {s('waiting')}
          </text>
          <text
            x="98"
            y="16"
            textAnchor="end"
            className="sim-row-state sim-warn-text sim-r13-local-t"
          >
            {s('localOnly')}
          </text>
          <text
            x="120"
            y="16"
            textAnchor="end"
            className="sim-row-state sim-ok-text sim-r13-synced"
          >
            ✓ {s('synced')}
          </text>
        </g>
        {/* G014: the visitor's ticket */}
        <g transform="translate(14 94)">
          <rect width="128" height="24" rx="6" className="sim-row sim-row-mine" />
          <text x="8" y="16" className="sim-row-code">
            G014
          </text>
          <text x="120" y="16" textAnchor="end" className="sim-row-state sim-r14-wait">
            {s('waiting')}
          </text>
          <text
            x="120"
            y="16"
            textAnchor="end"
            className="sim-row-state sim-ok-text sim-r14-called"
          >
            ✓ {s('called')}
          </text>
        </g>
      </g>
      {/* other devices during the outage */}
      <text x="310" y="90" textAnchor="middle" className="sim-muted sim-capture">
        {s('captureOnly')}
      </text>
    </svg>
  );
}
