import React from 'react';
import { motion } from 'framer-motion';
import { Building2, Globe, Star, Tag, Edit, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { useToast } from '@/components/ui/use-toast';
// Supabase removed

const CompanyCard = ({ company, index, onEdit, onDelete }) => {
  const { toast } = useToast();
  const cardVariants = {
    hidden: { opacity: 0, y: 50 },
    visible: { opacity: 1, y: 0, transition: { delay: index * 0.1 } },
  };

  const handleDelete = async () => {
    try {
        // First, delete related records if necessary, depending on cascade settings.
        // Supabase foreign keys are set to cascade delete, so this should be enough:
        const { error } = await supabase.from('companies').delete().eq('id', company.id);
        
        if (error) throw error;
        
        toast({
            title: "Success",
            description: "Company deleted successfully."
        });
        onDelete(); // Refresh the list
    } catch (error) {
        toast({
            variant: "destructive",
            title: "Error deleting company",
            description: error.message
        });
    }
  };

  return (
    <motion.div
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      whileHover={{ y: -5, scale: 1.02,
        boxShadow: "0px 15px 30px -5px rgba(148, 106, 226, 0.3)" 
      }}
      className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20 hover:border-purple-400 transition-all duration-300 flex flex-col justify-between h-full"
    >
      <div>
        <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-4">
                <div className="p-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl">
                    <Building2 className="w-6 h-6 text-white" />
                </div>
                <h2 className="text-xl font-bold text-white truncate">{company.name}</h2>
            </div>
            <div className="flex gap-1">
                 <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-300 hover:text-white hover:bg-white/20" onClick={onEdit}>
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
                            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                            <AlertDialogDescription className="text-gray-400">
                                This action cannot be undone. This will permanently delete the company and all its related data.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel className="border-gray-600 hover:bg-gray-700">Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        </div>

        <p className="text-gray-300 text-sm mb-4 line-clamp-2 min-h-[40px]">{company.about || 'No description available.'}</p>
        
        {company.industries && company.industries.length > 0 && (
          <div className="flex items-start gap-2 mb-4">
            <Tag className="w-4 h-4 text-purple-400 mt-1 flex-shrink-0" />
            <div className="flex flex-wrap gap-2">
              {company.industries.slice(0, 3).map((industry) => (
                <span key={industry.id} className="bg-purple-500/20 text-purple-300 text-xs font-medium px-2.5 py-1 rounded-full">
                  {industry.name}
                </span>
              ))}
              {company.industries.length > 3 && (
                <span className="bg-gray-500/20 text-gray-300 text-xs font-medium px-2.5 py-1 rounded-full">
                  +{company.industries.length - 3} more
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 mb-4 text-sm text-gray-400">
            <Star className={`w-4 h-4 ${company.star_rating > 0 ? 'text-yellow-400 fill-yellow-400' : 'text-gray-500'}`} />
            <span>{company.star_rating ? `${Number(company.star_rating).toFixed(1)}/5.0` : 'No rating'}</span>
        </div>
      </div>

      <div>
        <a
          href={company.website_url || undefined}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => !company.website_url && e.preventDefault()}
          className={`flex items-center justify-center gap-2 w-full text-center px-4 py-2 rounded-lg font-semibold transition-all duration-300 ${company.website_url ? 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white' : 'bg-gray-600 text-gray-400 cursor-not-allowed'}`}
        >
          <Globe className="w-4 h-4" />
          Visit Website
        </a>
      </div>
    </motion.div>
  );
};

export default CompanyCard;
