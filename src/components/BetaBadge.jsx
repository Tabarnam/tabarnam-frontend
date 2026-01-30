import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
      style={{
        width: 'clamp(110px, 12vw, 160px)',
        height: 'clamp(110px, 12vw, 160px)',
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
        className="absolute text-white font-bold text-xs tracking-tight"
        style={{
          top: '18px',
          left: '16px',
        }}
      >
        Early Access
      </div>
    </div>
  );
}
