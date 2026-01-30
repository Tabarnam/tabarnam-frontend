import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
      style={{
        width: '200px',
        height: '200px',
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
        className="absolute text-white font-bold tracking-widest"
        style={{
          top: '25px',
          left: '15px',
          fontSize: '14px',
          fontWeight: '700',
          letterSpacing: '0.1em',
        }}
      >
        Early Access
      </div>
    </div>
  );
}
