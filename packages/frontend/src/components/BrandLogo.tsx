import React from 'react';

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showSubtext?: boolean;
  collapsed?: boolean;
  variant?: 'light' | 'dark' | 'auto';
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 'md',
  showSubtext = true,
  collapsed = false,
}) => {
  const iconSizes = {
    sm: 36,
    md: 48,
    lg: 64,
  };

  const titleSizes = {
    sm: '15px',
    md: '19px',
    lg: '26px',
  };

  const subSizes = {
    sm: '9.5px',
    md: '10.5px',
    lg: '12px',
  };

  const iconDim = iconSizes[size];

  // Exact 5-Flame Lotus Mark matching user reference image
  const FlameLotusSVG = (
    <svg
      width={iconDim}
      height={iconDim * 0.85}
      viewBox="0 0 400 320"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        flexShrink: 0,
        filter: 'drop-shadow(0 2px 8px rgba(255, 85, 0, 0.4))',
      }}
    >
      <defs>
        <linearGradient id="exactFlameGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#F24E00" />
          <stop offset="35%" stopColor="#FF6B00" />
          <stop offset="70%" stopColor="#FF9E00" />
          <stop offset="100%" stopColor="#EAA627" />
        </linearGradient>
      </defs>

      {/* 1. Central Teardrop Flame */}
      <path
        d="M200 120 C182 170 135 198 135 240 C135 274 165 295 200 295 C235 295 265 274 265 240 C265 198 218 170 200 120 Z"
        fill="url(#exactFlameGrad)"
      />

      {/* 2. Inner Left Flame Petal */}
      <path
        d="M140 58 C144 125 112 185 84 235 C112 268 144 262 160 220 C175 175 166 102 140 58 Z"
        fill="url(#exactFlameGrad)"
      />

      {/* 3. Inner Right Flame Petal */}
      <path
        d="M260 58 C256 125 288 185 316 235 C288 268 256 262 240 220 C225 175 234 102 260 58 Z"
        fill="url(#exactFlameGrad)"
      />

      {/* 4. Outer Left Wing Flame */}
      <path
        d="M42 16 C48 95 18 165 22 278 C60 285 96 220 74 156 C61 118 52 58 42 16 Z"
        fill="url(#exactFlameGrad)"
      />

      {/* 5. Outer Right Wing Flame */}
      <path
        d="M358 16 C352 95 382 165 378 278 C340 285 304 220 326 156 C339 118 348 58 358 16 Z"
        fill="url(#exactFlameGrad)"
      />
    </svg>
  );

  if (collapsed) {
    return (
      <div
        title="Gold Audit Pro — by Sumeru Global"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {FlameLotusSVG}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', overflow: 'hidden' }}>
      {FlameLotusSVG}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span
          style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontWeight: 700,
            fontSize: titleSizes[size],
            lineHeight: 1.1,
            background: 'linear-gradient(180deg, #F3D98A 0%, #D8AE47 55%, #A8791F 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
          }}
        >
          Gold Audit Pro
        </span>
        {showSubtext && (
          <span
            style={{
              fontFamily: "'Manrope', sans-serif",
              fontSize: subSizes[size],
              fontWeight: 600,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
              marginTop: '2px',
              whiteSpace: 'nowrap',
            }}
          >
            by Sumeru Global
          </span>
        )}
      </div>
    </div>
  );
};
