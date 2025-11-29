import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { HeadquartersLocation } from '@/types/company';

interface HeadquartersLocationsEditorProps {
  primaryHQ: string;
  additionalHQs: HeadquartersLocation[];
  onPrimaryChange: (hq: string) => void;
  onAdditionalsChange: (hqs: HeadquartersLocation[]) => void;
}

const HeadquartersLocationsEditor: React.FC<HeadquartersLocationsEditorProps> = ({
  primaryHQ = '',
  additionalHQs = [],
  onPrimaryChange,
  onAdditionalsChange,
}) => {
  const [additionalHQInput, setAdditionalHQInput] = useState('');

  const handleAddAdditionalHQ = () => {
    const trimmedInput = additionalHQInput.trim();
    if (!trimmedInput) return;

    const newHQ: HeadquartersLocation = {
      address: trimmedInput,
      is_hq: false,
    };

    onAdditionalsChange([...additionalHQs, newHQ]);
    setAdditionalHQInput('');
  };

  const handleRemoveAdditionalHQ = (indexToRemove: number) => {
    onAdditionalsChange(additionalHQs.filter((_, idx) => idx !== indexToRemove));
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddAdditionalHQ();
    }
  };

  return (
    <div className="space-y-4">
      {/* Primary HQ */}
      <div>
        <Label htmlFor="primary_hq">Primary Headquarters Location</Label>
        <Input
          id="primary_hq"
          type="text"
          value={primaryHQ}
          onChange={(e) => onPrimaryChange(e.target.value)}
          placeholder="City, State/Region, Country (e.g., San Ramon, CA, USA)"
          className="w-full"
        />
      </div>

      {/* Additional HQs */}
      <div>
        <Label>Additional HQ Locations</Label>

        {/* Display additional HQs as chips */}
        {additionalHQs.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {additionalHQs.map((hq, idx) => (
              <div
                key={idx}
                className="bg-[#B1DDE3] text-slate-900 px-3 py-1 rounded-md text-sm flex items-center gap-2 font-medium"
              >
                {hq.address || `HQ ${idx + 1}`}
                <button
                  type="button"
                  onClick={() => handleRemoveAdditionalHQ(idx)}
                  className="text-slate-700 hover:text-slate-900 font-bold ml-1"
                  aria-label={`Remove ${hq.address || `HQ ${idx + 1}`}`}
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
            type="text"
            value={additionalHQInput}
            onChange={(e) => setAdditionalHQInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="City, State/Region, Country (e.g., Toronto, ON, Canada)"
            className="flex-1"
          />
          <Button
            type="button"
            onClick={handleAddAdditionalHQ}
            className="px-4 py-2 bg-[#B1DDE3] text-slate-900 rounded hover:bg-[#A0C8D0] font-medium"
          >
            Add HQ
          </Button>
        </div>

        {additionalHQs.length > 0 && (
          <p className="text-xs text-slate-500 mt-2">
            {additionalHQs.length} additional {additionalHQs.length === 1 ? 'location' : 'locations'} added
          </p>
        )}
      </div>
    </div>
  );
};

export default HeadquartersLocationsEditor;
