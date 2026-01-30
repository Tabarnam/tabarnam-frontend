import React from 'react';

export default function BetaBadge() {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 9999,
        pointerEvents: 'none',
        overflow: 'visible',
        width: '110px',
        height: '110px',
      }}
    >
      {/* Triangle background - clipped only */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(135, 206, 235, 0.7)',
          clipPath: 'polygon(0 0, 0 100%, 100% 0)',
          zIndex: 0,
        }}
      />

      {/* Text positioned above background - NOT clipped */}
      <div
        style={{
          position: 'absolute',
          color: '#ffffff',
          opacity: 1,
          display: 'block',
          visibility: 'visible',
          fontSize: '11px',
          fontWeight: 700,
          whiteSpace: 'nowrap',
          lineHeight: 1,
          top: '38px',
          left: '3px',
          transform: 'rotate(-45deg)',
          transformOrigin: 'left center',
          letterSpacing: '-0.5px',
          textShadow: '0 1px 2px rgba(0,0,0,0.35)',
          zIndex: 10,
        }}
      >
        Early Access
      </div>
    </div>
  );
}
