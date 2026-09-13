import React from 'react';
import { Page } from './Page';
import { SkeletonList } from './Loading';

/**
 * The shape of a page that has not arrived yet.
 *
 * Every first navigation in this app went through `RouteFallback`: the whole content area replaced
 * by the word "Loading…", centred in 60vh of nothing. Roughly fifty routes are code-split, so that
 * is what the app looks like the first time you open any screen in a session — the header and the
 * sidebar stay, the content becomes a blank field with one grey word in the middle of it, and then
 * the real page appears somewhere else entirely. It reads as a stall, and the jump when the content
 * lands is the reason screens feel unsteady.
 *
 * This holds the page's real shape instead: a title, a line of subtitle, and the rows that are
 * coming. Nothing moves when the content replaces it.
 *
 * `deferred-appear` means a fast chunk shows none of this at all. A skeleton that flashes for 60ms
 * is worse than the blank it replaced — see the class in index.css.
 */
export const PageSkeleton: React.FC<{ rows?: number }> = ({ rows = 5 }) => (
  <Page>
    <div className="deferred-appear" aria-hidden="true">
      <div
        className="skeleton-bar"
        style={{ height: 22, width: 240, borderRadius: 'var(--radius-sm)', marginBottom: 'var(--space-2-5)' }}
      />
      <div
        className="skeleton-bar"
        style={{ height: 12, width: 420, maxWidth: '70%', borderRadius: 'var(--radius-xs)', marginBottom: 'var(--space-6)' }}
      />
      <SkeletonList rows={rows} />
    </div>
    {/*
      Said once, for a screen reader, because everything above is decoration. Without this the
      announcement is silence until the page lands.
    */}
    <span role="status" aria-live="polite" style={{
      position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
    }}>
      Loading the page
    </span>
  </Page>
);

export default PageSkeleton;
