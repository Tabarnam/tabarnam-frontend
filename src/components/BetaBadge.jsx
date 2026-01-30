import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
      style={{
        width: '400px',
        height: '400px',
      }}
    >
      <div
        className="absolute bg-tabarnam-blue/70 backdrop-blur-sm flex items-center justify-center"
        style={{
          padding: '12px 24px',
          whiteSpace: 'nowrap',
          top: '0',
          left: '0',
          transform: 'rotate(-45deg)',
          transformOrigin: '0 0',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0, 95, 115, 0.15)',
          minWidth: 'max-content',
        }}
      >
        <div className="text-white font-bold text-sm tracking-tight">
          Early Access
        </div>
      </div>
    </div>
  );
}
