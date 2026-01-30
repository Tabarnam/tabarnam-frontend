import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
      style={{
        width: '250px',
        height: '250px',
        overflow: 'hidden',
        clipPath: 'polygon(0 0, 100% 0, 0 100%)',
      }}
    >
      <div
        className="absolute bg-tabarnam-blue/70 backdrop-blur-sm"
        style={{
          width: '280px',
          height: '280px',
          top: '-70px',
          left: '-70px',
          transform: 'rotate(-45deg)',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0, 95, 115, 0.15)',
        }}
      />
      <div
        className="absolute text-white font-bold tracking-widest whitespace-nowrap"
        style={{
          top: '20px',
          left: '10px',
          fontSize: '12px',
          fontWeight: '700',
          letterSpacing: '0.08em',
        }}
      >
        Early Access
      </div>
    </div>
  );
}
