import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import { COMMON_MESSAGE_TOKENS } from '@fapoms/shared';
import { TemplateStudioHeader, TemplatePicker, TemplateDetailBar, CommonTokenChips } from './TemplateStudio';

/**
 * The shape both template screens are made of.
 *
 * These are here because the email screen and the text-message screen now depend on the same
 * pieces: a change that looks harmless on one screen lands on the other one too. What is pinned is
 * what the screens actually rely on — which card is the chosen one (announced, not only coloured),
 * that the list can be reached by keyboard, and that a card's state is readable rather than a
 * colour somebody has to interpret.
 */

const ITEMS = [
  {
    key: 'mfa-code',
    name: 'Sign-in verification code',
    description: 'The one-time code for signing in.',
    badge: '1 part',
    status: { tone: 'success' as const, label: 'DLT Template ID set' },
  },
  {
    key: 'app-credentials',
    name: 'App access credentials',
    description: 'The username and temporary password.',
    badge: '2 parts',
    status: { tone: 'warning' as const, label: 'Cannot send yet — no DLT Template ID' },
    flag: <span>Edited</span>,
  },
];

describe('the template picker', () => {
  it('shows every template with what it is and what state it is in', () => {
    render(<TemplatePicker label="Texts to choose from" items={ITEMS} selectedKey="mfa-code" onSelect={jest.fn()} />);

    expect(screen.getByRole('group', { name: 'Texts to choose from' })).toBeInTheDocument();
    expect(screen.getByText('The one-time code for signing in.')).toBeInTheDocument();
    expect(screen.getByText('Cannot send yet — no DLT Template ID')).toBeInTheDocument();
    expect(screen.getByText('Edited')).toBeInTheDocument();
  });

  /** The chosen card is orange; a person who cannot see that needs to be told some other way. */
  it('announces which one is open rather than only colouring it', () => {
    render(<TemplatePicker label="Texts to choose from" items={ITEMS} selectedKey="mfa-code" onSelect={jest.fn()} />);

    expect(screen.getByRole('button', { name: /Sign-in verification code/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /App access credentials/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens the one that is clicked, and the one that is chosen with the keyboard', () => {
    const onSelect = jest.fn();
    render(<TemplatePicker label="Texts to choose from" items={ITEMS} selectedKey="mfa-code" onSelect={onSelect} />);
    const card = screen.getByRole('button', { name: /App access credentials/ });

    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledWith('app-credentials');

    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  /** An empty grid while the list is loading reads as "there are none", which is a different fact. */
  it('shows it is still loading instead of an empty list', () => {
    render(<TemplatePicker label="Texts to choose from" items={[]} selectedKey="" onSelect={jest.fn()} loading />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the studio header and detail bar', () => {
  it('puts the actions beside the title and the picker underneath', () => {
    render(
      <TemplateStudioHeader
        icon={<span />}
        title="Text message (SMS) studio"
        description="The wording of every text."
        actions={<button type="button">Send this text to a phone</button>}
      >
        <TemplatePicker label="Texts to choose from" items={ITEMS} selectedKey="mfa-code" onSelect={jest.fn()} />
      </TemplateStudioHeader>,
    );

    expect(screen.getByText('Text message (SMS) studio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send this text to a phone' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Texts to choose from' })).toBeInTheDocument();
  });

  /** "Am I editing the right one?" is the question asked just before saving over the wrong thing. */
  it('names the open template, its key, its state and what can be done to it', () => {
    render(
      <TemplateDetailBar
        icon={<span />}
        name="Sign-in verification code"
        itemKey="mfa-code"
        footnote="The one-time code for signing in."
        pills={<span>Standard wording</span>}
        actions={<button type="button">Restore the standard wording</button>}
      />,
    );

    expect(screen.getByText('Sign-in verification code')).toBeInTheDocument();
    expect(screen.getByText('(mfa-code)')).toBeInTheDocument();
    expect(screen.getByText('Standard wording')).toBeInTheDocument();
    expect(screen.getByText('The one-time code for signing in.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore the standard wording' })).toBeInTheDocument();
  });
});

/**
 * The placeholders every message carries, on both screens from one component.
 *
 * The owner asked for one set of dynamic values — the person's name, the number, the time — usable
 * in any wording rather than a different vocabulary per message. Two screens offer them, so they
 * are offered from here: a list written twice is a list that disagrees with itself within a release.
 */
describe('the placeholders every message carries', () => {
  it('offers the whole shared set, not a list this screen keeps of its own', () => {
    render(<CommonTokenChips onInsert={jest.fn()} />);

    for (const token of COMMON_MESSAGE_TOKENS) {
      expect(screen.getByRole('button', { name: `{{${token}}}` })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button')).toHaveLength(COMMON_MESSAGE_TOKENS.length);
  });

  it('hands the screen the placeholder that was clicked, for it to put where it belongs', () => {
    const onInsert = jest.fn();
    render(<CommonTokenChips onInsert={onInsert} />);

    fireEvent.click(screen.getByRole('button', { name: '{{name}}' }));

    expect(onInsert).toHaveBeenCalledWith('name');
  });

  /**
   * A template that fills a value itself wins over the shared one — a candidate's name on a message
   * going to their manager, say. The chip still works; what changes is what it says it will mean,
   * because somebody typing {{name}} there is entitled to know whose name arrives.
   */
  it('says when this template fills one of them with its own value', () => {
    render(<CommonTokenChips onInsert={jest.fn()} overriddenBy={['name']} />);

    expect(screen.getByRole('button', { name: '{{name}}' }))
      .toHaveAttribute('title', expect.stringContaining('this message fills it with its own value'));
    expect(screen.getByRole('button', { name: '{{time}}' }))
      .toHaveAttribute('title', expect.not.stringContaining('its own value'));
  });
});
