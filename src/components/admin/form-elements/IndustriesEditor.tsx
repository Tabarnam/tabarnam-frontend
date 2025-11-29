import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

interface IndustriesEditorProps {
  industries: string[];
  onChange: (industries: string[]) => void;
  label?: string;
  placeholder?: string;
}

const IndustriesEditor: React.FC<IndustriesEditorProps> = ({
  industries = [],
  onChange,
  label = 'Industries',
  placeholder = 'Add an industry (e.g., Technology, Manufacturing) and press Enter',
}) => {
  const [inputValue, setInputValue] = useState('');

  const handleAddIndustry = () => {
    const trimmedValue = inputValue.trim();
    if (!trimmedValue) return;
    
    // Check for duplicates (case-insensitive)
    if (industries.some(ind => ind.toLowerCase() === trimmedValue.toLowerCase())) {
      setInputValue('');
      return;
    }

    onChange([...industries, trimmedValue]);
    setInputValue('');
  };

  const handleRemoveIndustry = (indexToRemove: number) => {
    onChange(industries.filter((_, idx) => idx !== indexToRemove));
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddIndustry();
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="industries">{label}</Label>
      
      {/* Display current industries as chips */}
      {industries.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {industries.map((industry, idx) => (
            <div
              key={idx}
              className="bg-[#B1DDE3] text-slate-900 px-3 py-1 rounded-md text-sm flex items-center gap-2 font-medium"
            >
              {industry}
              <button
                type="button"
                onClick={() => handleRemoveIndustry(idx)}
                className="text-slate-700 hover:text-slate-900 font-bold ml-1"
                aria-label={`Remove ${industry}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input section */}
      <div className="flex gap-2">
        <Input
          id="industries"
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={placeholder}
          className="flex-1"
        />
        <Button
          type="button"
          onClick={handleAddIndustry}
          className="px-4 py-2 bg-[#B1DDE3] text-slate-900 rounded hover:bg-[#A0C8D0] font-medium"
        >
          Add
        </Button>
      </div>

      {industries.length > 0 && (
        <p className="text-xs text-slate-500">
          {industries.length} {industries.length === 1 ? 'industry' : 'industries'} added
        </p>
      )}
    </div>
  );
};

export default IndustriesEditor;
