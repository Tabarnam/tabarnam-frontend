import React from 'react';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from 'lucide-react';

const LocationInput = ({ title, locations, onChange, onAdd, onRemove, type }) => (
    <div>
        <h3 className="form-label font-semibold">{title}</h3>
        <div className="space-y-2">
            {locations.map((loc, index) => (
                <div key={index} className="flex items-center gap-2">
                    <input
                        type="text"
                        placeholder="Enter full address"
                        value={loc.full_address || ''}
                        onChange={(e) => onChange(index, e.target.value, type)}
                        className="form-input flex-grow"
                    />
                    {locations.length > 1 && (
                        <Button type="button" variant="destructive" size="icon" className="h-9 w-9" onClick={() => onRemove(index)}>
                            <Trash2 size={16} />
                        </Button>
                    )}
                </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={onAdd} className="text-purple-300 border-purple-500/50 hover:bg-purple-500/10 hover:text-purple-200">
                <Plus size={16} className="mr-2"/> Add Location
            </Button>
        </div>
    </div>
);

export default LocationInput;