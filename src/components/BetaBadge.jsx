import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
    >
      <div
        className="absolute bg-tabarnam-blue/70 backdrop-blur-sm flex items-center justify-center"
        style={{
          padding: '10px 20px',
          whiteSpace: 'nowrap',
          top: '0',
          left: '-25px',
          width: 'max-content',
          transform: 'rotate(45deg)',
          transformOrigin: 'top left',
          borderRadius: '2px',
          boxShadow: '0 4px 12px rgba(0, 95, 115, 0.15)',
        }}
      >
        <div className="text-white font-bold text-xs tracking-tight">
          Early Access
        </div>
      </div>
    </div>
  );
}
