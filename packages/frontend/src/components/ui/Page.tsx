import React from 'react';

/**
 * The root of a screen.
 *
 * Every page in the app drew its own: a column flex with a gap, and — on about a third of them —
 * a padding and a max width of its own invention. The gaps ran 10, 14, 16, 18, 20, 22 and 24px;
 * the paddings 0, 16px, 24px, `20px 24px` and `0 8px 16px`; the max widths 900, 1000, 1100, 1200
 * and 1500px. All of it sat *inside* a shell that already pads the content area and already caps
 * and centres it at `--content-max-width`, so the extra padding was doubled padding and the extra
 * max width was a second, narrower cap nobody had decided on. That is why the left edge of the
 * content moved as you navigated, and why two screens opened side by side never quite agreed.
 *
 * So: no padding here, because `.page-scroll` has it. One gap, because a page is a stack of
 * sections and they should breathe the same on every screen. And a max width chosen from three
 * named options rather than typed as a number — `narrow` for a screen that reads as a single
 * column, where full width would drag the eye across a 27" monitor to read one form.
 */
export interface PageProps {
  /**
   * How wide the content may get inside the shell's own cap.
   * `full` (the default) uses all of it; `narrow` is for forms and single-column queues.
   */
  width?: 'full' | 'medium' | 'narrow';
  /**
   * The page manages its own scrolling — a map, a split pane, a live log tail. It then fills the
   * scroll region's height exactly rather than growing past it.
   */
  fills?: boolean;
  /** Escape hatch for a genuinely different root. Merged last, so it wins. */
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

const MAX_WIDTH: Record<NonNullable<PageProps['width']>, string | undefined> = {
  full: undefined,
  medium: 'var(--content-max-width-medium)',
  narrow: 'var(--content-max-width-narrow)',
};

export const Page: React.FC<PageProps> = ({
  width = 'full',
  fills = false,
  style,
  className,
  children,
}) => (
  <div
    className={className}
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-4)',
      maxWidth: MAX_WIDTH[width],
      // A capped page centres inside the shell's container rather than hugging the sidebar.
      marginInline: width === 'full' ? undefined : 'auto',
      width: '100%',
      minWidth: 0,
      // `min-height: 0` releases the flex default that refuses to shrink below content, which is
      // what lets an inner pane scroll instead of pushing the page taller.
      ...(fills ? { height: '100%', minHeight: 0 } : null),
      ...style,
    }}
  >
    {children}
  </div>
);

export default Page;
