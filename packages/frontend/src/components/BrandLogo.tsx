import React from 'react';

/**
 * The Sumeru Global mark.
 *
 * This renders the real supplied asset (`public/logo.avif`, with a PNG fallback for
 * browsers without AVIF support). It previously drew a hand-authored SVG described in its
 * own comment as "matching user reference image" — a traced approximation that was visibly
 * not the same mark, alongside two other unrelated logos in `public/` for a different
 * product ("Gold Audit Pro"). Substituting a lookalike for a company's actual logo is not a
 * detail to get approximately right, so nothing here redraws it.
 *
 * The artwork is entirely orange on transparency — flame *and* wordmark — so one file works
 * on both the light and dark themes with no separate dark variant.
 */

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg';
  /** Show the "Field Audit Operations" support line under the mark. */
  showSubtext?: boolean;
  /** Sidebar collapsed: render the mark alone. */
  collapsed?: boolean;
}

/* The asset is 104x80 (13:10). Heights are derived from that ratio so it is never stretched. */
const LOGO_RATIO = 104 / 80;

const HEIGHTS: Record<NonNullable<BrandLogoProps['size']>, number> = {
  sm: 30,
  md: 40,
  lg: 60,
};

const SUB_SIZES: Record<NonNullable<BrandLogoProps['size']>, string> = {
  sm: '8.5px',
  md: '9.5px',
  lg: '11px',
};

export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 'md',
  showSubtext = true,
  collapsed = false,
}) => {
  const h = HEIGHTS[size];
  const w = Math.round(h * LOGO_RATIO);

  const mark = (
    /* <picture> serves the original AVIF where supported and the PNG conversion
       everywhere else — both are the same artwork, so there is no visual fork. */
    <picture style={{ display: 'inline-flex', flexShrink: 0 }}>
      <source srcSet="/logo.avif" type="image/avif" />
      <img
        src="/sumeru-logo.png"
        srcSet="/sumeru-logo.png 1x, /sumeru-logo@2x.png 2x"
        width={w}
        height={h}
        alt="Sumeru Global"
        style={{ display: 'block', width: w, height: h, objectFit: 'contain' }}
      />
    </picture>
  );

  if (collapsed) {
    return <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }} title="Sumeru Global">{mark}</div>;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }} title="Sumeru Global">
      {mark}
      {showSubtext && (
        /* The wordmark is part of the artwork, so only the support line is set in type —
           adding a second "Sumeru Global" in a system font beside the real one would read
           as a duplicate. */
        <span
          style={{
            fontFamily: "'Manrope', sans-serif",
            fontSize: SUB_SIZES[size],
            fontWeight: 600,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            whiteSpace: 'nowrap',
            lineHeight: 1.2,
          }}
        >
          Field Audit
          <br />
          Operations
        </span>
      )}
    </div>
  );
};

export default BrandLogo;
