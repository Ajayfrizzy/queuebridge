import { useCallback, useEffect, useId, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { StoryScene } from './StoryScene.js';

/** How long each stage is shown while the story plays (six stages: a 30 s loop). */
export const STAGE_MS = 5000;

/**
 * Reduced motion, from either the operating system or the device preference (M5.2,
 * `data-motion="reduce"` on <html>), followed live.
 */
export function useReducedMotion(): boolean {
  const read = (): boolean =>
    document.documentElement.getAttribute('data-motion') === 'reduce' ||
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduced(read());
    mq?.addEventListener?.('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    return () => {
      mq?.removeEventListener?.('change', update);
      mo.disconnect();
    };
  }, []);
  return reduced;
}

interface Stage {
  title: string;
  caption: string;
}

/**
 * M7.2 animated continuity story (design §14.4.2, §14.5; REQ-F15.4).
 *
 * - Every stage's title and caption is always in the page as text, in order; the picture only
 *   illustrates the current one.
 * - Plays on its own (a 30 s loop), so a visible Pause/Play control is provided (WCAG 2.2.2).
 *   Previous/Next and the stage list pause it, so the reader keeps control.
 * - Automatic changes are never announced (no live-region chatter); a change the person makes is
 *   announced once, politely.
 * - Reduced motion (system or device setting): no autoplay and no transition; all six stages are
 *   shown together with their pictures, with the same meaning.
 * - Stops while the tab is hidden. It only changes what is drawn: no data, no requests.
 */
export function ContinuityStory(): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const stages = t('story.stages', { returnObjects: true }) as Stage[];
  const total = stages.length;
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [said, setSaid] = useState('');
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');

  useEffect(() => {
    const on = (): void => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const running = playing && !reduced && !hidden;
  // Each (re)start of the timer restarts the stage clock, so the progress bar and the timer agree
  const [runs, setRuns] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    setRuns((r) => r + 1);
    const timer = setInterval(() => setIndex((i) => (i + 1) % total), STAGE_MS);
    return () => clearInterval(timer);
  }, [running, total]);

  const go = useCallback(
    (next: number): void => {
      const i = (next + total) % total;
      setPlaying(false);
      setIndex(i);
      setSaid(`${t('story.stageOf', { n: i + 1, total })}: ${stages[i]?.title ?? ''}`);
    },
    [stages, t, total],
  );

  if (reduced) {
    return (
      <section aria-labelledby={`${id}-h`} className="landing-section story" data-testid="story">
        <h2 id={`${id}-h`}>{t('story.heading')}</h2>
        <p className="landing-intro">{t('story.intro')}</p>
        <p className="muted" data-testid="story-static-note">
          {t('story.staticNote')}
        </p>
        <ol className="story-static" data-testid="story-stages" data-mode="static">
          {stages.map((s, i) => (
            <li key={s.title} className="story-card" data-testid="story-stage">
              <StoryScene stage={i + 1} title={s.title} />
              <p className="story-step">{t('story.stageOf', { n: i + 1, total })}</p>
              <h3>{s.title}</h3>
              <p>{s.caption}</p>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  const current = stages[index];
  return (
    <section aria-labelledby={`${id}-h`} className="landing-section story" data-testid="story">
      <h2 id={`${id}-h`}>{t('story.heading')}</h2>
      <p className="landing-intro">{t('story.intro')}</p>
      <div className="story-layout" data-mode="animated">
        <div className="story-stage-panel">
          <div className="story-scene-frame">
            {/* one persistent drawing: stages change by CSS transitions (opacity/transform) */}
            <StoryScene stage={index + 1} title={current?.title ?? ''} playing={running} />
            <div
              className="story-progress"
              aria-hidden="true"
              data-running={running ? 'true' : 'false'}
            >
              <span key={`${index}-${runs}`} className="story-progress-bar" />
            </div>
          </div>
          <div className="story-controls" role="group" aria-label={t('story.controls')}>
            <button type="button" className="btn btn-secondary" onClick={() => go(index - 1)}>
              {t('story.previous')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="story-toggle"
              onClick={() => {
                setPlaying((p) => !p);
                setSaid('');
              }}
            >
              {playing ? t('story.pause') : t('story.resume')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => go(index + 1)}>
              {t('story.next')}
            </button>
          </div>
          <p className="story-step" data-testid="story-position">
            {t('story.stageOf', { n: index + 1, total })}
          </p>
        </div>
        <div className="story-list" data-testid="story-stages" data-mode="animated">
          <div className="story-copy">
            {stages.map((stage, i) => (
              <div
                key={stage.title}
                data-testid="story-stage"
                aria-current={index === i ? 'step' : undefined}
              >
                <h3 className="story-item-title">{stage.title}</h3>
                <p className="story-caption">{stage.caption}</p>
              </div>
            ))}
          </div>
          <div className="story-controls">
            {stages.map((stage, i) => (
              <button
                key={stage.title}
                className="btn btn-secondary"
                type="button"
                aria-label={`${i + 1}. ${stage.title}`}
                aria-pressed={i === index}
                onClick={() => go(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p role="status" className="visually-hidden" data-testid="story-announce">
        {said}
      </p>
    </section>
  );
}
