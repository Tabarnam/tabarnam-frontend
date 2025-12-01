import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
      style={{
        width: '100px',
        height: '100px',
        overflow: 'hidden',
        clipPath: 'polygon(0 0, 100% 0, 0 100%)',
      }}
    >
      <div
        className="absolute bg-tabarnam-blue/70 backdrop-blur-sm text-white font-bold tracking-widest flex items-center justify-center"
        style={{
          width: '140px',
          height: '140px',
          top: '-40px',
          left: '-40px',
          transform: 'rotate(-45deg)',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0, 95, 115, 0.15)',
          fontSize: '20px',
        }}
      >
        Early
      </div>
    </div>
  );
}
