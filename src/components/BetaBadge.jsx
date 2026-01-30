import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
      style={{
        width: 'clamp(56px, 6vw, 88px)',
        height: 'clamp(56px, 6vw, 88px)',
      }}
    >
      {/* Triangle background */}
      <div
        className="absolute inset-0 bg-tabarnam-blue/70"
        style={{
          clipPath: 'polygon(0 0, 0 100%, 100% 0)',
        }}
      />

      {/* Text positioned inside triangle */}
      <div
        className="absolute text-white font-bold text-[10px] whitespace-nowrap"
        style={{
          top: '14px',
          left: '8px',
          transform: 'rotate(-45deg)',
          transformOrigin: 'top left',
          letterSpacing: '-0.5px',
        }}
      >
        Early Access
      </div>
    </div>
  );
}
