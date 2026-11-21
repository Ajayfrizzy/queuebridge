// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CapabilityEntry,
  CapabilityManifest,
  FacilityReadiness,
} from '@queuebridge/contracts';
import { channelView, LANDING_CHANNELS } from './channels.js';
import { ContinuityStory, STAGE_MS } from './ContinuityStory.js';
import { createLandingI18n } from './i18n.js';
import { en } from './locales/en.js';
import { adminSteps, canAdminister } from './Onboarding.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = (caps: Partial<Record<string, CapabilityEntry>>): CapabilityManifest =>
  ({
    version: 1,
    generatedAt: '2026-11-20T10:00:00.000Z',
    capabilities: caps,
  }) as CapabilityManifest;

describe('M7.2 channel availability comes from the capability manifest (fail closed)', () => {
  it('the current baseline: web and QR live, SMS and USSD sandbox (never usable)', () => {
    const m = manifest({
      visitor_join: { status: 'live', availability: 'available' },
      sms_turn_alerts: { status: 'sandbox', availability: 'available' },
      ussd: { status: 'sandbox', availability: 'available' },
    });
    expect(channelView(m, 'visitor_join')).toMatchObject({ status: 'live', usable: true });
    expect(channelView(m, 'sms_turn_alerts')).toMatchObject({ status: 'sandbox', usable: false });
    expect(channelView(m, 'ussd')).toMatchObject({ status: 'sandbox', usable: false });
  });
  it('a change of status changes the description', () => {
    const live = manifest({ sms_turn_alerts: { status: 'live', availability: 'available' } });
    expect(channelView(live, 'sms_turn_alerts')).toMatchObject({ status: 'live', usable: true });
    const off = manifest({
      sms_turn_alerts: {
        status: 'live',
        availability: 'unavailable',
        unavailableReason: 'not_configured',
      },
      visitor_join: {
        status: 'live',
        availability: 'unavailable',
        unavailableReason: 'switched_off',
      },
      ussd: {
        status: 'planned',
        availability: 'unavailable',
        unavailableReason: 'not_implemented',
      },
    });
    expect(channelView(off, 'sms_turn_alerts')).toMatchObject({
      status: 'notSetUp',
      usable: false,
    });
    expect(channelView(off, 'visitor_join')).toMatchObject({
      status: 'switchedOff',
      usable: false,
    });
    expect(channelView(off, 'ussd')).toMatchObject({ status: 'planned', usable: false });
    const sandboxOff = manifest({
      ussd: { status: 'sandbox', availability: 'unavailable', unavailableReason: 'not_configured' },
    });
    expect(channelView(sandboxOff, 'ussd')).toMatchObject({
      status: 'sandbox',
      explain: 'sandboxNotSetUp',
      usable: false,
    });
  });
  it('no manifest or a missing entry is never shown as available', () => {
    for (const c of LANDING_CHANNELS) {
      expect(channelView(null, c)).toMatchObject({ status: 'unknown', usable: false });
      expect(channelView(manifest({}), c)).toMatchObject({ status: 'unknown', usable: false });
    }
  });
  it('every status and explanation has copy, and sandbox copy says it is not production', () => {
    for (const k of ['live', 'sandbox', 'preview', 'planned', 'notSetUp', 'switchedOff', 'unknown'])
      expect(en.channels.status[k as keyof typeof en.channels.status]).toBeTruthy();
    expect(en.channels.explain.sandbox).toMatch(/not a production service/i);
    expect(en.channels.status.sandbox).not.toMatch(/live/i);
  });
});

describe('M7.2 localization', () => {
  it('every landing string resolves through i18next (no raw keys)', () => {
    const i18n = createLandingI18n();
    const walk = (o: unknown, path: string[]): void => {
      if (typeof o === 'string') {
        const key = path.join('.');
        const v = i18n.t(key, {
          n: 1,
          total: 6,
          title: 'x',
          facility: 'F',
          code: 'A',
          service: 'S',
        });
        expect(v, key).not.toBe(key);
        expect(String(v), key).not.toMatch(/\{\{/);
        return;
      }
      if (Array.isArray(o)) o.forEach((x, i) => walk(x, [...path, String(i)]));
      else if (o && typeof o === 'object')
        for (const [k, v] of Object.entries(o)) walk(v, [...path, k]);
    };
    walk(en, []);
  });
  it('rendered text follows the resource bundle (a translated bundle replaces the copy)', () => {
    const fr = { ...en, hero: { ...en.hero, title: 'Des files qui avancent.' } };
    const i18n = createLandingI18n({ en, fr } as { en: object }, 'fr');
    expect(i18n.t('hero.title')).toBe('Des files qui avancent.');
    // anything not translated falls back to English, never to a key
    expect(i18n.t('hero.primary')).toBe(en.hero.primary);
  });
  it('the copy makes no forbidden claim', () => {
    const all = JSON.stringify(en);
    expect(en.footer.accessibility).toContain('has not been independently audited or certified');
    expect(all).not.toMatch(
      /conflict[- ]free|guarantee|always (?:online|deliver|arrive)|tamper[- ]?proof|\d+\s?%|customers? (?:say|love)/i,
    );
  });
});

describe('M7.2 onboarding steps', () => {
  const ready: FacilityReadiness = {
    configuration_ready: true,
    facility_active: true,
    services: [
      {
        id: '00000000-0000-7000-8000-000000000001',
        name: 'S',
        status: 'active',
        operational: true,
        active_counter_count: 1,
        configured_counter_count: 1,
      },
    ],
    counters: [],
    issues: [],
    visitor_join: { operational: true, reason: '' },
  };
  const fac = {
    id: '00000000-0000-7000-8000-00000000000f',
    name: 'Clinic',
    slug: 'clinic',
    timezone: 'UTC',
    status: 'active' as const,
    created_at: '2026-11-20T10:00:00.000Z',
  };
  it('links each step to the real screen for the facility and reflects readiness', () => {
    const s = adminSteps(fac, ready);
    expect(s.map((x) => x.to)).toEqual([
      null,
      '/admin',
      `/admin/facilities/${fac.id}/services`,
      `/admin/facilities/${fac.id}/counters`,
      `/admin/facilities/${fac.id}/staff`,
      `/admin/facilities/${fac.id}`,
      `/staff/facilities/${fac.id}`,
    ]);
    expect(s.map((x) => x.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'unknown',
      'unknown',
      'unknown',
    ]);
    const notReady = adminSteps(fac, { ...ready, configuration_ready: false, services: [] });
    expect(notReady[2]?.state).toBe('todo');
    expect(notReady[3]?.state).toBe('todo');
    // readiness not loaded yet: no claim either way
    expect(adminSteps(fac, null)[3]?.state).toBe('unknown');
  });
  it('with no facility only Administration is linked; nothing is claimed done after step 1', () => {
    const s = adminSteps(null, null);
    expect(s.map((x) => x.to)).toEqual([null, '/admin', null, null, null, null, null]);
    expect(s.slice(1).every((x) => x.state === 'todo')).toBe(true);
  });
  it('administrators are org admins or facility admins only', () => {
    const u = (
      roles: { role: string; facility_id: string | null }[],
    ): Parameters<typeof canAdminister>[0] =>
      ({
        id: 'u',
        email: 'e',
        display_name: 'd',
        organization: { id: 'o', name: 'O', slug: 'o' },
        roles,
      }) as Parameters<typeof canAdminister>[0];
    expect(canAdminister(u([{ role: 'org_admin', facility_id: null }]))).toBe(true);
    expect(canAdminister(u([{ role: 'facility_admin', facility_id: 'f' }]))).toBe(true);
    expect(canAdminister(u([{ role: 'staff_counter', facility_id: 'f' }]))).toBe(false);
  });
});

describe('M7.2 continuity story', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = (el: ReactElement): void => {
    act(() => root.render(<I18nextProvider i18n={createLandingI18n()}>{el}</I18nextProvider>));
  };
  const current = (): string =>
    container.querySelector('[aria-current="step"] .story-item-title')?.textContent ?? '';
  const toggle = (): HTMLButtonElement =>
    container.querySelector('[data-testid="story-toggle"]') as HTMLButtonElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.removeAttribute('data-motion');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    document.documentElement.removeAttribute('data-motion');
  });

  it('shows every stage as text and plays through all six in order, looping', () => {
    render(<ContinuityStory />);
    const titles = [...container.querySelectorAll('.story-item-title')].map((e) => e.textContent);
    expect(titles).toEqual(en.story.stages.map((s) => s.title));
    const captions = [...container.querySelectorAll('.story-caption')].map((e) => e.textContent);
    expect(captions).toEqual(en.story.stages.map((s) => s.caption));
    const seen: string[] = [current()];
    for (let i = 0; i < 6; i++) {
      act(() => vi.advanceTimersByTime(STAGE_MS));
      seen.push(current());
    }
    expect(seen).toEqual([...en.story.stages.map((s) => s.title), en.story.stages[0]!.title]);
    // automatic changes are never announced
    expect(container.querySelector('[data-testid="story-announce"]')?.textContent).toBe('');
  });

  it('Pause stops it; Play resumes; Next pauses and announces once', () => {
    render(<ContinuityStory />);
    expect(toggle().textContent).toBe(en.story.pause);
    act(() => toggle().click());
    expect(toggle().textContent).toBe(en.story.resume);
    const at = current();
    act(() => vi.advanceTimersByTime(STAGE_MS * 3));
    expect(current()).toBe(at);
    act(() => toggle().click());
    act(() => vi.advanceTimersByTime(STAGE_MS));
    expect(current()).toBe(en.story.stages[1]!.title);
    const next = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === en.story.next,
    )!;
    act(() => next.click());
    expect(current()).toBe(en.story.stages[2]!.title);
    expect(toggle().textContent).toBe(en.story.resume);
    expect(container.querySelector('[data-testid="story-announce"]')?.textContent).toBe(
      `Stage 3 of 6: ${en.story.stages[2]!.title}`,
    );
  });

  it('reduced motion: all six stages shown statically, nothing plays, no controls', async () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    render(<ContinuityStory />);
    const stages = container.querySelectorAll('[data-testid="story-stage"]');
    expect(stages).toHaveLength(6);
    expect(container.querySelectorAll('svg.story-scene')).toHaveLength(6);
    expect(container.querySelector('[data-testid="story-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="story-stages"]')?.getAttribute('data-mode')).toBe(
      'static',
    );
    // switching the device setting back follows live
    await act(async () => {
      document.documentElement.setAttribute('data-motion', 'system');
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="story-toggle"]')).not.toBeNull();
  });
});
