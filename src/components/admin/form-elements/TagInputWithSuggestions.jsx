import React, { useState, useRef, useEffect } from 'react';
import { X, AlertCircle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Simple Levenshtein distance for spellcheck
const levenshteinDistance = (str1, str2) => {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = Array(len2 + 1)
    .fill(null)
    .map(() => Array(len1 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[0][i] = i;
  for (let j = 0; j <= len2; j++) matrix[j][0] = j;

  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }

  return matrix[len2][len1];
};

// Find spelling corrections
const findSpellingCorrections = (input, suggestions) => {
  if (!input || input.length < 2) return [];

  const input_lower = input.toLowerCase();
  const corrections = suggestions
    .map((s) => ({
      suggestion: s,
      distance: levenshteinDistance(input_lower, s.toLowerCase()),
    }))
    .filter((item) => item.distance > 0 && item.distance <= Math.max(2, Math.floor(input.length / 2)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((item) => item.suggestion);

  return corrections;
};

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
  const [spellingCorrections, setSpellingCorrections] = useState([]);
  const [hasSpellingIssue, setHasSpellingIssue] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!inputValue.trim()) {
      setFilteredSuggestions([]);
      setSpellingCorrections([]);
      setHasSpellingIssue(false);
      return;
    }

    const lowerInput = inputValue.toLowerCase().trim();

    // Get exact matches first
    const exactMatches = suggestions
      .filter(
        (s) =>
          s.toLowerCase().includes(lowerInput) &&
          !tags.some((t) => t.toLowerCase() === s.toLowerCase())
      )
      .slice(0, 8);

    setFilteredSuggestions(exactMatches);

    // Check for spelling issues if no exact matches
    if (exactMatches.length === 0) {
      const corrections = findSpellingCorrections(inputValue, suggestions.filter(
        (s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase())
      ));
      setSpellingCorrections(corrections);
      setHasSpellingIssue(corrections.length > 0);
    } else {
      setSpellingCorrections([]);
      setHasSpellingIssue(false);
    }

    setIsOpen(exactMatches.length > 0 || spellingCorrections.length > 0 || allowCustom);
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
      } else if (spellingCorrections.length > 0) {
        handleAddTag(spellingCorrections[0]);
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
        <div className={cn(
          "border-2 rounded-md p-2 min-h-10 cursor-text bg-white transition-colors",
          hasSpellingIssue ? "border-amber-400" : "border-slate-400 hover:border-slate-600"
        )}>
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
          </div>
        </div>
        <div className="border-2 border-dashed border-slate-300 rounded-md px-3 py-2 min-h-9 bg-slate-50 focus-within:border-blue-500 focus-within:bg-blue-50 transition-colors mt-2">
          <Input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsOpen(true)}
            onBlur={() => setTimeout(() => setIsOpen(false), 150)}
            placeholder={placeholder}
            spellCheck="true"
            className="border-0 shadow-none p-0 h-auto text-sm placeholder:text-slate-500 focus:ring-0 w-full bg-transparent"
          />
        </div>

        {isOpen && (
          <div
            className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg p-3 w-full max-w-sm z-50"
            onMouseDown={(e) => e.preventDefault()}
          >
            {isLoading ? (
              <div className="text-sm text-slate-600 p-2 text-center">Loading...</div>
            ) : (
              <div className="space-y-3">
                {/* Exact match suggestions */}
                {filteredSuggestions.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                      <CheckCircle size={12} className="inline mr-1" />
                      Suggestions
                    </p>
                    <div className="space-y-1">
                      {filteredSuggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleAddTag(suggestion);
                            inputRef.current?.focus();
                          }}
                          className="w-full text-left px-3 py-2 rounded hover:bg-blue-50 text-sm text-slate-800 transition-colors font-medium"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Spelling corrections */}
                {spellingCorrections.length > 0 && (
                  <div className="border-t border-slate-200 pt-3">
                    <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
                      <AlertCircle size={12} className="inline mr-1" />
                      Did you mean?
                    </p>
                    <div className="space-y-1">
                      {spellingCorrections.map((correction) => (
                        <button
                          key={correction}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleAddTag(correction);
                            inputRef.current?.focus();
                          }}
                          className="w-full text-left px-3 py-2 rounded hover:bg-amber-50 text-sm text-slate-800 transition-colors"
                        >
                          {correction}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Add custom tag */}
                {allowCustom && inputValue.trim() && filteredSuggestions.length === 0 && (
                  <div className={spellingCorrections.length > 0 ? "border-t border-slate-200 pt-3" : ""}>
                    <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Custom</p>
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleAddTag(inputValue);
                        inputRef.current?.focus();
                      }}
                      className="w-full text-left px-3 py-2 rounded hover:bg-slate-100 text-sm text-slate-800 transition-colors"
                    >
                      Add "{inputValue.trim()}"
                    </button>
                  </div>
                )}

                {/* Empty state */}
                {filteredSuggestions.length === 0 && spellingCorrections.length === 0 && (!allowCustom || !inputValue.trim()) && (
                  <div className="text-sm text-slate-600 p-2 text-center">
                    {inputValue ? "No matches found" : "Start typing..."}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
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
