import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

const MultiToggle = ({ options, selected, onSelect }) => {
  return (
    <div className="flex items-center bg-gray-200/80 backdrop-blur-sm p-1 rounded-full shadow-md">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onSelect(option.value)}
          className={cn(
            'relative w-full px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors focus:outline-none',
            { 'text-gray-900': selected === option.value }
          )}
        >
          <span className="relative z-10 flex items-center justify-center gap-2">
            {option.icon}
            {option.label}
          </span>
          {selected === option.value && (
            <motion.div
              layoutId="multi-toggle-highlight"
              className="absolute inset-0 bg-tabarnam-blue rounded-full"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            />
          )}
        </button>
      ))}
    </div>
  );
};

export default MultiToggle;