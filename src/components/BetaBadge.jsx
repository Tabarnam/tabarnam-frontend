import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed bottom-0 left-0 z-50 pointer-events-none"
      style={{
        width: '200px',
        height: '200px',
        overflow: 'visible',
      }}
    >
      <div
        className="absolute bg-tabarnam-blue/70 backdrop-blur-sm text-white font-bold tracking-widest flex items-center justify-center"
        style={{
          width: '280px',
          height: '60px',
          bottom: '-30px',
          left: '-70px',
          transform: 'rotate(-45deg)',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0, 95, 115, 0.15)',
          fontSize: '27px',
        }}
      >
        Beta
      </div>
    </div>
  );
}
