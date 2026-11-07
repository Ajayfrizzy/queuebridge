import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'correct-horse-battery-1';

export function uid(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

const CSRF = { 'X-QB-CSRF': '1' };

export interface Org {
  slug: string;
  email: string;
  name: string;
}

/** Create an organization through the public API (fast setup for tests that are not about signup). */
export async function apiSignup(request: APIRequestContext, name = 'API Org'): Promise<Org> {
  const slug = uid('org');
  const email = `admin-${slug}@example.test`;
  const res = await request.post('/api/v1/organizations', {
    headers: CSRF,
    data: {
      organization_name: name,
      organization_slug: slug,
      admin_display_name: 'Org Admin',
      admin_email: email,
      admin_password: PASSWORD,
    },
  });
  expect(res.status()).toBe(201);
  return { slug, email, name };
}

export async function apiFacility(
  request: APIRequestContext,
  name = 'Main Clinic',
): Promise<{ id: string; slug: string }> {
  const slug = uid('fac');
  const res = await request.post('/api/v1/facilities', {
    headers: CSRF,
    data: { name, slug, timezone: 'Africa/Lagos' },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { facility: { id: string; slug: string } };
  return body.facility;
}

export async function uiLogin(
  page: Page,
  orgSlug: string,
  email: string,
  password = PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Organization URL identifier').fill(orgSlug);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Run axe against the current page; fail with a readable list on any WCAG 2.x A/AA violation. */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
  expect(summary, `axe violations on ${page.url()}`).toEqual([]);
}

/** True when the page needs horizontal scrolling (a layout failure on narrow screens). */
export async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}
