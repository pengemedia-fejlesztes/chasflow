// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryModal } from '../web/src/EntryModal';
import { StoreProvider } from '../web/src/store';
import { Modal } from '../web/src/ui';
import { App } from '../web/src/App';
import { api } from '../web/src/api';

vi.mock('../web/src/api', () => ({ api: vi.fn() }));
vi.mock('../web/src/Desktop', () => ({ Desktop: () => null, logout: vi.fn() }));
vi.mock('../web/src/Mobile', () => ({ Mobile: () => null }));
vi.mock('../web/src/PartnerCard', () => ({ PartnerCardHost: () => null }));
vi.mock('../web/src/LeafPicker', () => ({ LeafPicker: () => null }));
let root: Root;
let host: HTMLDivElement;
const initial = () =>
  ({
    today: '2026-10-30',
    me: { id: 1, role: 'admin' },
    groups: [{ id: 'g', section: 'in', label: 'Test', sort: 0 }],
    leaves: [{ id: 'l', group_id: 'g', label: 'Client', sort: 0, archived: 0 }],
    entries: [],
    series: [],
    accounts: [],
    settings: {},
  }) as any;
const click = async (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom does not implement the browser's native modal top layer.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  // a Modal a dokumentumban nyílik (show), hogy az oldal görgetése görgesse
  HTMLDialogElement.prototype.show = function () {
    this.open = true;
  };
  window.scrollTo = vi.fn() as any;
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(api).mockReset();
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function editor() {
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <StoreProvider initial={initial()}>
        <EntryModal leaf="l" onClose={onClose} />
      </StoreProvider>,
    ),
  );
  return onClose;
}
function saveButton() {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Mentés'))!;
}

describe('editor saves', () => {
  it('keeps the editor and typed values after a rejected save; closes only after success', async () => {
    const onClose = await editor();
    await type(document.querySelector('[aria-label="Összeg forintban"]')!, '1250');
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/api/data') return initial();
      throw new Error('Offline');
    });
    await click(saveButton());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Összeg forintban"]')!.value).toBe('1250');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('A mentés nem sikerült');
    vi.mocked(api).mockImplementation(async (_path, opts) => ({ versions: Object.fromEntries((opts?.body as any).upsert.map((e: any) => [e.id, 1])) }));
    await click(saveButton());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('blocks decimal amounts and duplicate submission while the request is pending', async () => {
    const onClose = await editor();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Összeg forintban"]')!;
    await type(input, '1250,50');
    await click(saveButton());
    expect(api).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Egész forint');
    await type(input, '1250');
    let resolve!: (v: any) => void;
    vi.mocked(api).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await click(saveButton());
    await click(saveButton());
    expect(api).toHaveBeenCalledTimes(1);
    expect(saveButton().disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    const body = vi.mocked(api).mock.calls[0][1]!.body as any;
    expect(body.expected[body.upsert[0].id]).toBeNull();
    await act(async () => resolve({ versions: { [body.upsert[0].id]: 1 } }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('dialog and login semantics', () => {
  it('opens a named native modal and routes Escape through the close handler', async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <Modal onClose={onClose} title="Új tétel">
          <input />
          <button>Mentés</button>
        </Modal>,
      ),
    );
    const dialog = document.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Új tétel');
    const cancel = new Event('cancel', { cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('keeps visible labels and allows returning from the second factor step', async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path === '/api/auth/status' ? { hasUsers: true, setupAvailable: false, mailEnabled: false, me: null } : { needTotp: true },
    );
    await act(async () => root.render(<App />));
    const email = document.querySelector<HTMLInputElement>('input[type="email"]')!;
    expect(email.closest('label')!.textContent).toContain('E-mail');
    const password = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(password.closest('label')!.textContent).toContain('Jelszó');
    await type(email, 'a@example.test');
    await type(password, 'password');
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const back = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Vissza a belépési adatokhoz')!;
    expect(back).toBeDefined();
    await click(back);
    expect(document.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe('a@example.test');
  });
});
