// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FacilityLoading, useFacilityPreview, useFacilitySessionKey } from './FacilityLoading.js';
import { ApiRequestError } from '../lib/api.js';

const auth = vi.hoisted(() => ({ user: {} }));
vi.mock('../auth.js', () => ({ useAuth: () => auth }));

it('previews a confirmed list only for the same session and drops it after access is denied', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  type State = 'pending' | 'confirmed' | 'denied';
  function List({ state }: { state: State }): ReactElement {
    const data = useFacilityPreview({
      data: state === 'confirmed' ? { facilities: [] } : null,
      loading: state === 'pending',
      error: state === 'denied' ? new ApiRequestError(403, null, 'Denied') : null,
      reload: async () => {},
    });
    return state === 'pending' ? <FacilityLoading what="facilities" updating={!!data} /> : <span />;
  }
  function Page({ state }: { state: State }): ReactElement {
    return <List key={useFacilitySessionKey()} state={state} />;
  }
  const show = async (state: State): Promise<void> => {
    await act(async () => root.render(<Page state={state} />));
  };
  try {
    await show('pending');
    expect(container.textContent).toContain('Loading facilities');
    await show('confirmed');
    await act(async () => root.render(null));
    await show('pending');
    expect(container.textContent).toContain('Updating facilities');
    await show('denied');
    await show('pending');
    expect(container.textContent).toContain('Loading facilities');
    await show('confirmed');
    auth.user = {};
    await show('pending');
    expect(container.textContent).toContain('Loading facilities');
  } finally {
    await act(async () => root.unmount());
  }
});
