import React from 'react';

const MultiSelectChip = ({ label, options, selected, setSelected, displayField }) => {
    const toggleSelection = (id) => {
        setSelected(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    };
    return (
        <div>
            <label className="form-label">{label}</label>
            <div className="flex flex-wrap gap-2 p-2 bg-gray-900/50 border border-white/20 rounded-lg min-h-[44px]">
                {options.map(option => (
                    <button type="button" key={option.id} onClick={() => toggleSelection(option.id)}
                        className={`px-3 py-1 rounded-full text-sm transition-all ${selected.includes(option.id) ? 'bg-purple-500 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}>
                        {option[displayField]}
                    </button>
                ))}
            </div>
        </div>
    );
};

export default MultiSelectChip;