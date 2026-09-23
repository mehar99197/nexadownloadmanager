/**
 * T-06, the IP allow-list half (M-06).
 *
 * This screen decides who can reach the control panels at all, and it is the
 * newest thing in the panel, so it is the least likely to still behave the way
 * anyone remembers. Four things are worth holding still:
 *
 *  - it warns, loudly, when the list contains `*` — which is the live state of
 *    this deployment right now, and the whole reason the warning exists;
 *  - `.env` entries are shown but not editable, because they are the
 *    break-glass route and the panel must not be able to remove them;
 *  - the server's refusal to let you lock yourself out (WOULD_LOCK_YOU_OUT)
 *    reaches the operator as words rather than a silent no-op;
 *  - the list reloads after a change, so the screen never shows a rule the
 *    server has already dropped.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('../api/client.js', () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    patch: (...a) => patch(...a),
    delete: (...a) => del(...a),
  },
  unwrap: async (p) => {
    const res = await p;
    if (res?.data?.ok === false) throw new Error(res.data.error?.message || 'failed');
    return res?.data?.data;
  },
  TWO_FACTOR_REQUIRED_EVENT: 'ndm:two-factor-required',
  SESSION_ENDED_EVENT: 'ndm:session-ended',
}));

const { default: IpAllowList } = await import('../components/IpAllowList.jsx');

const okBody = (data) => ({ data: { ok: true, data } });
const state = (over = {}) => okBody({
  rules: [],
  envList: [],
  rootEnvList: [],
  yourIp: '203.0.113.7',
  openToEveryone: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(state());
});

describe('the allow-list screen', () => {
  it('shows the address the server actually sees', async () => {
    render(<IpAllowList />);
    // Not cosmetic: adding the wrong address is how somebody locks themselves
    // out, and behind a proxy the address you think you have is often not it.
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
  });

  it('warns when the list is open to everyone', async () => {
    get.mockResolvedValue(state({ openToEveryone: true, envList: ['*'] }));
    render(<IpAllowList />);

    const warning = await screen.findByTestId('ip-open-to-everyone');
    expect(warning).toHaveTextContent('The gate is open to every address');
  });

  it('stays quiet when the list is actually filtering', async () => {
    get.mockResolvedValue(state({
      openToEveryone: false,
      rules: [{ id: 1, value: '203.0.113.0/24', label: 'Home', enabled: true }],
    }));
    render(<IpAllowList />);

    await screen.findByText('203.0.113.0/24');
    expect(screen.queryByTestId('ip-open-to-everyone')).not.toBeInTheDocument();
  });

  it('shows .env entries without offering a way to remove them', async () => {
    get.mockResolvedValue(state({ envList: ['198.51.100.4'] }));
    render(<IpAllowList />);

    expect(await screen.findByText('198.51.100.4')).toBeInTheDocument();
    // The break-glass route must survive whatever is done on this screen, so
    // there is no per-entry control next to it.
    expect(screen.queryByRole('button', { name: /stop allowing|remove/i })).not.toBeInTheDocument();
  });

  it('adds a rule and re-reads the list rather than guessing at it', async () => {
    post.mockResolvedValue(okBody({ id: 9 }));
    get
      .mockResolvedValueOnce(state())
      .mockResolvedValue(state({
        rules: [{ id: 9, value: '198.51.100.0/24', label: 'Office', enabled: true }],
      }));

    render(<IpAllowList />);
    await screen.findByText('203.0.113.7');

    await userEvent.clear(screen.getByLabelText(/address or range/i));
    await userEvent.type(screen.getByLabelText(/address or range/i), '198.51.100.0/24');
    await userEvent.type(screen.getByLabelText(/label/i), 'Office');
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/root/ip-rules',
      expect.objectContaining({ value: '198.51.100.0/24', label: 'Office' })
    ));
    // The row appears because the list was re-read, not because the component
    // optimistically appended something the server may have rejected.
    expect(await screen.findByText('198.51.100.0/24')).toBeInTheDocument();
  });

  it('puts the server’s lock-out refusal in front of the operator', async () => {
    get.mockResolvedValue(state({
      rules: [{ id: 3, value: '203.0.113.0/24', label: 'Home', enabled: true }],
    }));
    // What routes/root.js answers when the change would cut off the caller.
    patch.mockResolvedValue({
      data: {
        ok: false,
        error: {
          code: 'WOULD_LOCK_YOU_OUT',
          message: 'That would lock out 203.0.113.7, the address you are using',
        },
      },
    });

    render(<IpAllowList />);
    await screen.findByText('203.0.113.0/24');
    await userEvent.click(screen.getByRole('button', { name: /stop allowing/i }));

    // A silent failure here is the dangerous outcome: the operator believes the
    // gate narrowed when it did not.
    expect(await screen.findByText(/lock out 203\.0\.113\.7/i)).toBeInTheDocument();
  });

  it('says so plainly when the list is empty', async () => {
    render(<IpAllowList />);
    expect(
      await screen.findByText(/only the \.env entries above can reach the panels/i)
    ).toBeInTheDocument();
  });
});
