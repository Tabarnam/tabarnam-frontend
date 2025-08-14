import React, { useState, useMemo } from 'react';
import DataTable from 'react-data-table-component';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import { Filter, X, Download, Edit, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const AdminCompanyTable = ({ companies, onEdit, onDelete, onBulkEdit, userRole }) => {
    const { toast } = useToast();
    const [filterText, setFilterText] = useState('');
    const [resetPaginationToggle, setResetPaginationToggle] = useState(false);
    const [selectedRows, setSelectedRows] = useState([]);
    const [toggleCleared, setToggleCleared] = useState(false);

    const isAdmin = userRole === 'admin';

    const filteredItems = companies.filter(
        item => 
            (item.name && item.name.toLowerCase().includes(filterText.toLowerCase())) ||
            (item.about && item.about.toLowerCase().includes(filterText.toLowerCase())) ||
            (item.industries && item.industries.some(i => i.name.toLowerCase().includes(filterText.toLowerCase())))
    );

    const handleClear = () => {
        if (filterText) {
            setResetPaginationToggle(!resetPaginationToggle);
            setFilterText('');
        }
    };

    const convertToCSV = (data) => {
        const header = Object.keys(data[0]).join(',');
        const rows = data.map(row => 
            Object.values(row).map(value => {
                const strValue = String(value);
                if (strValue.includes(',')) return `"${strValue}"`;
                return strValue;
            }).join(',')
        );
        return [header, ...rows].join('\n');
    };

    const handleExport = () => {
        if (selectedRows.length === 0) {
            toast({ variant: 'destructive', title: "No rows selected", description: "Please select rows to export." });
            return;
        }
        const csvData = convertToCSV(selectedRows);
        const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', 'filtered_companies.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };
    
    const handleRowSelected = ({ allSelected, selectedCount, selectedRows }) => {
        setSelectedRows(selectedRows);
    };

    const contextActions = useMemo(() => {
        return (
            <div className="flex items-center gap-2">
                 <Button key="export" onClick={handleExport} size="sm" variant="outline" className="text-white border-white/20 hover:bg-white/10">
                    <Download className="mr-2 h-4 w-4" /> Export {selectedRows.length}
                </Button>
                {isAdmin && (
                    <Button key="bulk-edit" onClick={() => onBulkEdit(selectedRows)} size="sm" variant="outline" className="text-white border-white/20 hover:bg-white/10">
                        Bulk Edit {selectedRows.length}
                    </Button>
                )}
            </div>
        );
    }, [selectedRows, onBulkEdit, handleExport]);


    const columns = [
        { name: 'Company Name', selector: row => row.name, sortable: true, cell: row => <div className="font-bold">{row.name}</div> },
        { name: 'Tagline', selector: row => row.tagline, sortable: true, cell: row => <div className="truncate max-w-xs">{row.tagline}</div> },
        { name: 'Industries', cell: row => <div className="flex flex-wrap gap-1 py-1">{row.industries?.slice(0, 2).map(i => <span key={i.id} className="bg-purple-500/20 text-purple-300 text-xs font-medium px-2 py-0.5 rounded-full">{i.name}</span>)} {row.industries?.length > 2 && `+${row.industries.length - 2}`}</div> },
        { name: 'Rating', selector: row => row.star_rating, sortable: true, center: true, cell: row => <span>{row.star_rating ? `${Number(row.star_rating).toFixed(1)}` : 'N/A'}</span> },
        {
            name: 'Actions',
            cell: row => (
                <div className="flex gap-1">
                    {isAdmin && (
                        <>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-300 hover:text-white hover:bg-white/20" onClick={() => onEdit(row)}>
                                <Edit className="w-4 h-4" />
                            </Button>
                             <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-300 hover:text-red-500 hover:bg-red-500/20">
                                        <Trash2 className="w-4 h-4" />
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent className="bg-slate-900 border-purple-500 text-white">
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                                        <AlertDialogDescription className="text-gray-400">
                                            This will permanently delete the company: <strong>{row.name}</strong>. This action is tracked and can be undone from the History tab.
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel className="border-gray-600 hover:bg-gray-700">Cancel</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => onDelete(row.id)} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        </>
                    )}
                </div>
            ),
            ignoreRowClick: true,
            allowOverflow: true,
            button: true,
        },
    ];

    const customStyles = {
        table: { style: { backgroundColor: 'transparent' } },
        headRow: { style: { backgroundColor: 'rgba(255, 255, 255, 0.1)', borderBottomColor: 'rgba(255, 255, 255, 0.2)', color: '#E2E8F0' } },
        rows: {
            style: { backgroundColor: 'transparent', color: '#CBD5E1', '&:not(:last-of-type)': { borderBottomColor: 'rgba(255, 255, 255, 0.1)' } },
            highlightOnHoverStyle: { backgroundColor: 'rgba(192, 132, 252, 0.1)', color: 'white' },
        },
        pagination: { style: { backgroundColor: 'transparent', color: '#A0AEC0', borderTop: 'none' } },
        noData: { style: { backgroundColor: 'transparent', color: 'white', padding: '24px' } },
        contextMenu: { style: { backgroundColor: 'rgba(30, 41, 59, 1)', color: 'white' } },
    };

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-white/5 p-4 rounded-lg">
            <div className="flex justify-between items-center mb-4">
                <div className="relative w-full max-w-sm">
                    <Filter className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4" />
                    <Input
                        type="text"
                        placeholder="Filter companies..."
                        value={filterText}
                        onChange={e => setFilterText(e.target.value)}
                        className="pl-9 bg-gray-900/50 border-white/20 text-white"
                    />
                    <X className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4 cursor-pointer hover:text-white" onClick={handleClear} />
                </div>
            </div>
            <DataTable
                columns={columns}
                data={filteredItems}
                pagination
                paginationResetDefaultPage={resetPaginationToggle}
                customStyles={customStyles}
                highlightOnHover
                pointerOnHover
                selectableRows={isAdmin}
                onSelectedRowsChange={handleRowSelected}
                clearSelectedRows={toggleCleared}
                contextActions={contextActions}
            />
        </motion.div>
    );
};

export default AdminCompanyTable;