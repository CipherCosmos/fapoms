import React from 'react';

/**
 * What a list looks like while it is fetching.
 *
 * Screens here replaced their whole table with a line of text — "Loading branch master
 * repository..." — on every search, filter and page change. The table vanished and came back,
 * which reads as the app stalling rather than as data arriving, and it happened most on the
 * fastest interactions: typing in a search box already showing the answer.
 *
 * There are two different moments and they want different treatment:
 *
 *   - Nothing on screen yet. Draw the shape of the table so the page has its real layout
 *     immediately and the rows fill in — no reflow when they land.
 *   - Rows already on screen, fetching a narrower set. Keep them. Dim them slightly so it is
 *     clear they are about to change, and let the new set replace them in place.
 *
 * Neither one removes the header, the toolbar or the row count, so the page never goes blank
 * and never jumps.
 */

/** Placeholder rows shaped like the table that is coming. */
export const SkeletonRows: React.FC<{ rows?: number; columns: number }> = ({ rows = 8, columns }) => (
  <>
    {Array.from({ length: rows }, (_, r) => (
      <tr key={r} aria-hidden="true">
        {Array.from({ length: columns }, (__, c) => (
          <td key={c} style={{ padding: '11px 12px' }}>
            <span
              className="skeleton-bar"
              style={{
                display: 'block',
                height: 11,
                borderRadius: 4,
                // Varied widths so it reads as text rather than as a progress bar.
                width: `${[70, 55, 85, 45, 62, 78, 50, 66][(r + c) % 8]}%`,
              }}
            />
          </td>
        ))}
      </tr>
    ))}
  </>
);

/**
 * Wraps content that is being refreshed in place.
 *
 * `busy` dims and blocks pointer events so a row cannot be clicked as it is replaced by a
 * different row — the click would land on whatever arrived, which is how someone opens a
 * branch they did not choose.
 */
export const Refreshing: React.FC<{ busy: boolean; children: React.ReactNode }> = ({ busy, children }) => (
  <div
    style={{
      position: 'relative',
      opacity: busy ? 0.55 : 1,
      pointerEvents: busy ? 'none' : undefined,
      transition: 'opacity 120ms ease',
    }}
    aria-busy={busy || undefined}
  >
    {children}
  </div>
);
