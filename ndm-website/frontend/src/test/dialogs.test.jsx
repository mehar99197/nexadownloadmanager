import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { ConfirmProvider, useConfirm } from '../components/ConfirmDialog';
import Turnstile, { turnstileEnabled } from '../components/Turnstile';

function Consumer({ onAnswer }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={async () => onAnswer(await confirm({
        title: 'Cancel your subscription?', message: 'Nothing is deleted.', confirmLabel: 'Cancel it', danger: true,
      }))}
    >
      open
    </button>
  );
}

const renderWithProvider = (onAnswer) => render(
  <MemoryRouter>
    <ConfirmProvider>
      <Consumer onAnswer={onAnswer} />
    </ConfirmProvider>
  </MemoryRouter>
);

describe('ConfirmProvider — the window.confirm() replacement', () => {
  it('resolves true when the primary action is chosen', async () => {
    const answers = [];
    renderWithProvider((a) => answers.push(a));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'open' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Cancel your subscription?');
    expect(dialog).toHaveTextContent('Nothing is deleted.');

    await user.click(screen.getByRole('button', { name: 'Cancel it' }));
    await waitFor(() => expect(answers).toEqual([true]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resolves false on Cancel and on Escape, never acting by accident', async () => {
    const answers = [];
    renderWithProvider((a) => answers.push(a));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'open' }));
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(answers).toEqual([false]));

    await user.click(screen.getByRole('button', { name: 'open' }));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(answers).toEqual([false, false]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('Turnstile', () => {
  it('renders nothing and loads no script when the site has no site key', () => {
    // The test build has no VITE_TURNSTILE_SITE_KEY, which is the "off" state.
    expect(turnstileEnabled()).toBe(false);
    const { container } = render(<Turnstile onToken={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
  });
});
