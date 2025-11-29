import React, { useState, useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { X, ChevronDown } from 'lucide-react';

interface KeywordsEditorProps {
  keywords: string[];
  onChange: (keywords: string[]) => void;
  label?: string;
  placeholder?: string;
}

const KeywordsEditor: React.FC<KeywordsEditorProps> = ({
  keywords = [],
  onChange,
  label = 'Keywords',
  placeholder = 'Search and select keywords...',
}) => {
  const [inputValue, setInputValue] = useState('');
  const [availableKeywords, setAvailableKeywords] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [filteredKeywords, setFilteredKeywords] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch keywords from API on mount
  useEffect(() => {
    const fetchKeywords = async () => {
      try {
        setIsLoading(true);
        const res = await apiFetch('/keywords-list');
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const keywordsList = data?.keywords || data?.items || [];
          setAvailableKeywords(Array.isArray(keywordsList) ? keywordsList : []);
        } else {
          setAvailableKeywords([]);
        }
      } catch (error) {
        console.error('Error fetching keywords:', error);
        setAvailableKeywords([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchKeywords();
  }, []);

  // Update filtered keywords when input changes
  useEffect(() => {
    if (!inputValue.trim()) {
      setFilteredKeywords(availableKeywords);
      return;
    }

    const lowerInput = inputValue.toLowerCase().trim();
    const filtered = availableKeywords
      .filter(
        kw => 
          kw.toLowerCase().includes(lowerInput) &&
          !keywords.some(k => k.toLowerCase() === kw.toLowerCase())
      )
      .slice(0, 8);

    setFilteredKeywords(filtered);
  }, [inputValue, availableKeywords, keywords]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleAddKeyword = (keyword: string) => {
    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) return;

    if (keywords.some(k => k.toLowerCase() === trimmedKeyword.toLowerCase())) {
      setInputValue('');
      return;
    }

    onChange([...keywords, trimmedKeyword]);
    setInputValue('');
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const handleRemoveKeyword = (indexToRemove: number) => {
    onChange(keywords.filter((_, idx) => idx !== indexToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredKeywords.length > 0) {
        handleAddKeyword(filteredKeywords[0]);
      }
    }
  };

  const handleAddButtonClick = () => {
    if (filteredKeywords.length > 0) {
      handleAddKeyword(filteredKeywords[0]);
    } else if (inputValue.trim()) {
      handleAddKeyword(inputValue);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="keywords">{label}</Label>

      {/* Display current keywords as chips */}
      {keywords.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {keywords.map((keyword, idx) => (
            <div
              key={idx}
              className="bg-[#B1DDE3] text-slate-900 px-3 py-1 rounded-md text-sm flex items-center gap-2 font-medium"
            >
              {keyword}
              <button
                type="button"
                onClick={() => handleRemoveKeyword(idx)}
                className="text-slate-700 hover:text-slate-900 font-bold ml-1 p-0 h-4 w-4 flex items-center justify-center"
                aria-label={`Remove ${keyword}`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Search input with dropdown and Add button */}
      <div className="flex gap-2">
        <div className="relative flex-1" ref={containerRef}>
          <div
            className={cn(
              'relative flex items-center gap-2 rounded-md border px-3 py-2 bg-white transition-colors',
              isOpen ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-300 hover:border-slate-400'
            )}
          >
            <Input
              ref={inputRef}
              id="keywords"
              type="text"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setIsOpen(true);
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                setIsOpen(true);
              }}
              placeholder={placeholder}
              disabled={isLoading}
              className="border-0 shadow-none p-0 h-auto text-sm placeholder:text-slate-500 focus:ring-0 w-full bg-transparent"
            />
            <ChevronDown
              size={16}
              className={cn(
                'text-slate-400 transition-transform flex-shrink-0',
                isOpen && 'rotate-180'
              )}
            />
          </div>

          {/* Dropdown menu */}
          {isOpen && (
            <div
              className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg p-2 w-full max-h-64 overflow-y-auto z-50"
              onMouseDown={(e) => e.preventDefault()}
            >
              {isLoading ? (
                <div className="text-sm text-slate-600 p-3 text-center">Loading keywords...</div>
              ) : filteredKeywords.length > 0 ? (
                <div className="space-y-1">
                  {filteredKeywords.map((keyword) => (
                    <button
                      key={keyword}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleAddKeyword(keyword);
                      }}
                      className="w-full text-left px-3 py-2 rounded hover:bg-blue-50 text-sm text-slate-800 transition-colors font-medium"
                    >
                      {keyword}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-slate-600 p-3 text-center">
                  {inputValue.trim() && availableKeywords.length > 0
                    ? 'No matching keywords'
                    : availableKeywords.length === 0
                    ? 'No keywords available'
                    : 'Start typing to search...'}
                </div>
              )}
            </div>
          )}
        </div>
        <Button
          type="button"
          onClick={handleAddButtonClick}
          className="px-4 py-2 bg-[#B1DDE3] text-slate-900 rounded hover:bg-[#A0C8D0] font-medium h-10"
          disabled={isLoading || !inputValue.trim()}
        >
          Add
        </Button>
      </div>

      {keywords.length > 0 && (
        <p className="text-xs text-slate-500">
          {keywords.length} {keywords.length === 1 ? 'keyword' : 'keywords'} selected
        </p>
      )}
    </div>
  );
};

export default KeywordsEditor;
