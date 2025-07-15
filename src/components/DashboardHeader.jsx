import React from 'react';
import { motion } from 'framer-motion';
import { Database } from 'lucide-react';
import { useAuth } from '@/contexts/SupabaseAuthContext';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';

const DashboardHeader = () => {
    const { user, signOut } = useAuth();
    
    const handleSignOut = async () => {
        await signOut();
        toast({
            title: "Signed Out",
            description: "You have been successfully signed out.",
        });
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-12"
        >
            <div className="flex items-center justify-center mb-6">
                <div className="p-4 bg-gradient-to-r from-purple-500 to-pink-500 rounded-2xl">
                    <Database className="w-12 h-12 text-white" />
                </div>
            </div>
            <h1 className="text-5xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent mb-4">
                Company Dashboard
            </h1>
            <p className="text-xl text-gray-300 max-w-3xl mx-auto">
                Live data from your "MVP Remix" Supabase project.
            </p>
            {user && (
                <div className="mt-4 flex items-center justify-center gap-4">
                    <p className="text-gray-300">Welcome, {user.email}</p>
                    <Button onClick={handleSignOut} variant="outline" className="text-white border-white/20 hover:bg-white/10">Sign Out</Button>
                </div>
            )}
        </motion.div>
    );
};

export default DashboardHeader;