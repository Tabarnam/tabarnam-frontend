import React from 'react';

export default function BetaBadge() {
  return (
    <div
      className="fixed top-0 left-0 z-50 pointer-events-none"
      style={{
        width: '0',
        height: '0',
      }}
    >
      <div
        className="absolute bg-tabarnam-blue/70 backdrop-blur-sm flex items-center justify-center"
        style={{
          transform: 'rotate(-45deg)',
          transformOrigin: 'top left',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0, 95, 115, 0.15)',
          padding: '8px 16px',
          width: 'fit-content',
          whiteSpace: 'nowrap',
          top: '0',
          left: '0',
        }}
      >
        <div className="text-white font-bold text-xs">
          Early Access
        </div>
      </div>
    </div>
  );
}
