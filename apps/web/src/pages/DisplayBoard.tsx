import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import { Loading } from '../components/Form.js';
import { api, apiUrl } from '../lib/api.js';
import { useLiveUpdates } from '../lib/live.js';
import { useLoad } from '../lib/useLoad.js';

/**
 * Public display board (F7): ticket codes and counter names only — never names, phone numbers
 * or internal ids. Optional spoken announcements must be switched on by a person (browsers block
 * audio without a user gesture, and audio should be a deliberate choice).
 */
export function DisplayBoard(): ReactElement {
  const { orgSlug = '', facilitySlug = '' } = useParams();
  const board = useLoad(() => api.board(orgSlug, facilitySlug), `${orgSlug}/${facilitySlug}`);
  const reload = board.reload;
  const live = useLiveUpdates(
    board.data ? apiUrl(`/public/facilities/${orgSlug}/${facilitySlug}/stream`) : null,
    null,
    useCallback(() => void reload(), [reload]),
  );
  const [speak, setSpeak] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const b = board.data?.board;
    if (!b) return;
    const current = new Set(
      b.services.flatMap((s) =>
        s.now_calling
          .filter((c) => c.state === 'called')
          .map((c) => `${c.public_code}@${c.counter_name}`),
      ),
    );
    if (seen.current) {
      const fresh = [...current].filter((k) => !seen.current?.has(k));
      if (fresh.length > 0) {
        const text = fresh
          .map((k) => {
            const [code, counter] = k.split('@');
            return `Ticket ${code?.split('').join(' ')}, please go to ${counter}.`;
          })
          .join(' ');
        setAnnouncement(text);
        if (speak && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        }
      }
    }
    seen.current = current;
  }, [board.data, speak]);

  if (board.loading && !board.data) return <Loading what="display" />;
  if (board.error || !board.data) {
    return (
      <>
        <h1>Display unavailable</h1>
        <p role="alert">This display link is not active.</p>
      </>
    );
  }
  const b = board.data.board;
  return (
    <div className="board">
      <div className="toolbar toolbar-spread">
        <h1>{b.facility_name}</h1>
        <div className="toolbar">
          <span className="badge badge-off" data-testid="live-mode">
            {live === 'live'
              ? 'Live'
              : live === 'polling'
                ? 'Refreshing every 15 s'
                : 'Connecting…'}
          </span>
          <label className="check inline">
            <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} />{' '}
            Spoken announcements
          </label>
        </div>
      </div>
      <div
        role="status"
        aria-live="polite"
        className="visually-hidden"
        data-testid="board-announcement"
      >
        {announcement}
      </div>
      {b.services.length === 0 ? (
        <p data-testid="board-empty">No queue is open right now.</p>
      ) : null}
      <div className="board-grid">
        {b.services.map((s, i) => (
          <section key={s.service_name} className="card" aria-labelledby={`board-svc-${i}`}>
            <h2 id={`board-svc-${i}`} className="card-title">
              {s.service_name}
              {s.state === 'paused' ? <span className="badge badge-off"> Paused</span> : null}
            </h2>
            <h3>Now calling</h3>
            <ul className="board-calls" data-testid="now-calling">
              {s.now_calling.length === 0 ? (
                <li className="muted">Nobody is being called.</li>
              ) : null}
              {s.now_calling.map((c) => (
                <li key={c.public_code} className="board-call">
                  <span className="board-code">{c.public_code}</span>
                  <span aria-hidden="true">→</span>
                  <span className="visually-hidden"> go to </span>
                  <span className="board-counter">{c.counter_name}</span>
                  {c.state === 'serving' ? <span className="muted">(being served)</span> : null}
                </li>
              ))}
            </ul>
            <h3>Next</h3>
            <ul
              className="code-chips"
              data-testid="next-codes"
              aria-label={`Next in ${s.service_name}`}
            >
              {s.next_codes.length === 0 ? <li className="muted">Nobody waiting</li> : null}
              {s.next_codes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <p className="muted">{s.waiting_count} waiting</p>
          </section>
        ))}
      </div>
    </div>
  );
}
