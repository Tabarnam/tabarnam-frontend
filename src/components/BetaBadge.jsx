import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
      style={{
        width: 'clamp(72px, 7vw, 100px)',
        height: 'clamp(72px, 7vw, 100px)',
        overflow: 'visible',
      }}
    >
      {/* Triangle background - clipped only */}
      <div
        className="absolute inset-0 bg-tabarnam-blue/70"
        style={{
          clipPath: 'polygon(0 0, 0 100%, 100% 0)',
          zIndex: 0,
        }}
      />

      {/* Text positioned above background - NOT clipped */}
      <div
        className="absolute text-white font-bold whitespace-nowrap"
        style={{
          fontSize: '11px',
          fontWeight: 600,
          top: '26px',
          left: '10px',
          transform: 'rotate(-45deg)',
          transformOrigin: 'left center',
          letterSpacing: '-0.5px',
          zIndex: 10,
        }}
      >
        Early Access
      </div>
    </div>
  );
}
