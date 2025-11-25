import React, { useState, useRef, useEffect } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const TagInputWithSuggestions = ({
  label,
  tags = [],
  onTagsChange,
  suggestions = [],
  isLoading = false,
  placeholder = 'Type to search...',
  allowCustom = true,
  maxTags = null,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!inputValue.trim()) {
      setFilteredSuggestions([]);
      return;
    }

    const lowerInput = inputValue.toLowerCase().trim();
    const filtered = suggestions
      .filter(
        (s) =>
          s.toLowerCase().includes(lowerInput) &&
          !tags.some((t) => t.toLowerCase() === s.toLowerCase())
      )
      .slice(0, 8);

    setFilteredSuggestions(filtered);
    setIsOpen(filtered.length > 0 || allowCustom);
  }, [inputValue, suggestions, tags, allowCustom]);

  const handleAddTag = (tag) => {
    const trimmedTag = tag.trim();
    if (!trimmedTag) return;

    if (maxTags && tags.length >= maxTags) {
      return;
    }

    if (tags.some((t) => t.toLowerCase() === trimmedTag.toLowerCase())) {
      setInputValue('');
      return;
    }

    onTagsChange([...tags, trimmedTag]);
    setInputValue('');
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const handleRemoveTag = (indexToRemove) => {
    onTagsChange(tags.filter((_, i) => i !== indexToRemove));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredSuggestions.length > 0) {
        handleAddTag(filteredSuggestions[0]);
      } else if (allowCustom && inputValue.trim()) {
        handleAddTag(inputValue);
      }
    } else if (e.key === ' ' && inputValue.trim()) {
      e.preventDefault();
      handleAddTag(inputValue);
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      handleRemoveTag(tags.length - 1);
    }
  };

  return (
    <div className="space-y-2">
      {label && (
        <label className="block text-sm font-medium text-slate-800">
          {label}
        </label>
      )}
      <div className="relative">
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <div className="border border-slate-300 rounded-md p-2 min-h-10 cursor-text bg-white hover:border-slate-400 transition-colors">
              <div className="flex flex-wrap gap-2">
                {tags.map((tag, idx) => (
                  <div
                    key={idx}
                    className="bg-[#B1DDE3] text-slate-900 text-sm px-3 py-1 rounded-full flex items-center gap-2 font-medium"
                  >
                    <span>{tag}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(idx)}
                      className="text-slate-700 hover:text-slate-900 focus:outline-none"
                      aria-label={`Remove ${tag}`}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <Input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onFocus={() => setIsOpen(true)}
                  placeholder={tags.length === 0 ? placeholder : ''}
                  className="border-0 shadow-none p-0 h-auto text-sm placeholder:text-slate-400 focus:ring-0"
                />
              </div>
            </div>
          </PopoverTrigger>

          {isOpen && (
            <PopoverContent align="start" className="p-2">
              {isLoading ? (
                <div className="text-sm text-slate-600 p-2 text-center">Loading...</div>
              ) : filteredSuggestions.length > 0 ? (
                <div className="space-y-1">
                  {filteredSuggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => handleAddTag(suggestion)}
                      className="w-full text-left px-3 py-2 rounded hover:bg-slate-100 text-sm text-slate-800 transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : allowCustom && inputValue.trim() ? (
                <button
                  onClick={() => handleAddTag(inputValue)}
                  className="w-full text-left px-3 py-2 rounded hover:bg-slate-100 text-sm text-slate-800 transition-colors"
                >
                  Add "{inputValue.trim()}"
                </button>
              ) : (
                <div className="text-sm text-slate-600 p-2 text-center">
                  No suggestions found
                </div>
              )}
            </PopoverContent>
          )}
        </Popover>
      </div>
      {maxTags && tags.length < maxTags && (
        <p className="text-xs text-slate-500">
          {maxTags - tags.length} slot{maxTags - tags.length !== 1 ? 's' : ''} remaining
        </p>
      )}
      {maxTags && tags.length >= maxTags && (
        <p className="text-xs text-slate-500">Maximum tags reached</p>
      )}
    </div>
  );
};

export default TagInputWithSuggestions;
