import React from 'react';
import { render, screen } from '@testing-library/react';
import { DeliveryHealthBanner, failingChannelSentences } from './DeliveryHealthBanner';

describe('DeliveryHealthBanner', () => {
  it('says nothing while every channel is working', () => {
    const { container } = render(<DeliveryHealthBanner delivery={[
      { channel: 'EMAIL', sent: 4, failing: 1, down: false },
      { channel: 'SMS', sent: 0, failing: 0, down: false },
    ]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the channel on which every send failed', () => {
    render(<DeliveryHealthBanner delivery={[{ channel: 'EMAIL', sent: 0, failing: 6, down: true }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Every email in the last 30 minutes failed (6 waiting or failed, none sent).');
  });

  it('copes with the status not reporting delivery at all', () => {
    expect(failingChannelSentences(null)).toEqual([]);
    expect(failingChannelSentences(undefined)).toEqual([]);
  });
});
