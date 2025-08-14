import React from 'react';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

const KeywordInput = ({ label, options, selected, setSelected, newKeyword, setNewKeyword, onAdd }) => {
    const selectedKeywordsObjects = selected.map(id => options.find(opt => opt.id === id)).filter(Boolean);

    const removeKeyword = (id) => {
        setSelected(prev => prev.filter(kId => kId !== id));
    };

    return (
        <div>
            <label className="form-label">{label}</label>
            <div className="p-2 bg-gray-900/50 border border-white/20 rounded-lg">
                <div className="flex flex-wrap gap-2 mb-2 min-h-[28px]">
                    {selectedKeywordsObjects.map(keyword => (
                        <div key={keyword.id} className="flex items-center gap-1 bg-purple-500 text-white px-3 py-1 rounded-full text-sm">
                            <span>{keyword.keyword}</span>
                            <button type="button" onClick={() => removeKeyword(keyword.id)} className="text-purple-200 hover:text-white">
                                <X size={14} />
                            </button>
                        </div>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={newKeyword}
                        onChange={(e) => setNewKeyword(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); }}}
                        placeholder="Add new keyword"
                        className="form-input flex-grow"
                    />
                    <Button type="button" onClick={onAdd} size="sm" className="bg-gray-600 hover:bg-gray-500">Add</Button>
                </div>
            </div>
        </div>
    );
};

export default KeywordInput;