// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RouteId } from '@queuebridge/contracts';
import { SafeArticle, parseBlocks } from './SafeArticle.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(body: string, permitted: Partial<Record<RouteId, string>> = {}): void {
  act(() =>
    root.render(
      <MemoryRouter>
        <SafeArticle body={body} pathFor={(id) => permitted[id] ?? null} />
      </MemoryRouter>,
    ),
  );
}

describe('SafeArticle (safe rendering of Safe Markdown)', () => {
  it('renders headings, numbered and bulleted lists, emphasis and paragraphs', () => {
    render(
      '# Steps\n\n1. Open **settings**.\n2. Choose _help_.\n\n- One\n- Two\n\nA closing line.',
    );
    expect(container.querySelector('h4')?.textContent).toBe('Steps');
    expect([...container.querySelectorAll('ol li')].map((l) => l.textContent)).toEqual([
      'Open settings.',
      'Choose help.',
    ]);
    expect(container.querySelector('strong')?.textContent).toBe('settings');
    expect(container.querySelector('em')?.textContent).toBe('help');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelector('p')?.textContent).toBe('A closing line.');
  });

  it('a route link is a link only when the user may open that screen here', () => {
    render('See [the audit trail](route:staff.audit) and [recovery](route:visitor.recover).', {
      'visitor.recover': '/recover',
    });
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['recovery', '/recover'],
    ]);
    expect(container.textContent).toContain('the audit trail');
  });

  it('never creates elements from text: HTML, scripts and unknown routes stay inert text', () => {
    render(
      '<img src=x onerror="alert(1)"> <script>alert(2)</script> [x](route:supervisor.home) [y](javascript:alert(3))',
    );
    expect(container.querySelector('img, script, iframe')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('<script>alert(2)</script>');
  });

  it('groups consecutive list items and splits paragraphs on blank lines', () => {
    expect(parseBlocks('a\nb\n\n- x\n- y\n1. z').map((b) => b.kind)).toEqual(['p', 'ul', 'ol']);
  });
});
