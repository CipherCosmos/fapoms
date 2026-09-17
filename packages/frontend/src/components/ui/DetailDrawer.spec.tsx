import React from 'react';
import { render, screen } from '@testing-library/react';
import { DetailDrawer } from './DetailDrawer';

/**
 * THE DRAWER THAT SCROLLED SIDEWAYS.
 *
 * Every drawer in the app is this component, and its body set only `overflowY: 'auto'`. CSS computes
 * the other axis to `auto` as well whenever one is not `visible`, so a document table or a row of
 * action links a few pixels wider than the panel gave the WHOLE drawer a horizontal scrollbar —
 * which is what the hiring page's reviewers were dragging back and forth.
 *
 * jsdom does no layout, so the width a table actually needs cannot be measured here. What can be
 * pinned is the geometry that decides whether an overflow scrolls the drawer or stays contained.
 */
describe('the drawer every detail panel is built on', () => {
  const open = (width?: number | string) => render(
    <DetailDrawer open onClose={jest.fn()} title="Somebody" width={width}>
      <p>content</p>
    </DetailDrawer>,
  );

  it('never lets its body scroll sideways', () => {
    open();
    const body = screen.getByTestId('detail-drawer-body');
    expect(body.style.overflowX).toBe('hidden');
    expect(body.style.overflowY).toBe('auto');
    // A flex child defaults to `min-width: auto`, which refuses to shrink below its content and
    // pushes the overflow back out to the panel; zero is what lets the content actually wrap.
    expect(['0', '0px']).toContain(body.style.minWidth);
  });

  it('takes a pixel width and clamps it to the screen', () => {
    open(640);
    expect(screen.getByRole('dialog').getAttribute('style')).toContain('min(640px, 100vw)');
  });

  /**
   * A string is any CSS length, so a content-heavy drawer can be wide on a desk monitor and still
   * fit a phone. The drawer was number-only, which is how the hiring drawers ended up stuck at a
   * fixed 640 and 760 pixels on every screen.
   */
  it('takes a responsive width as well as a pixel one', () => {
    open('min(920px, 94vw)');
    expect(screen.getByRole('dialog').getAttribute('style')).toContain('920px');
    expect(screen.getByRole('dialog').getAttribute('style')).toContain('94vw');
  });

  it('keeps its old default for every caller that passes nothing', () => {
    open();
    expect(screen.getByRole('dialog').getAttribute('style')).toContain('min(560px, 100vw)');
  });
});
