// src/components/DashboardHeader.jsx
import React from 'react';
import { motion } from 'framer-motion';
import { Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';

const DashboardHeader = () => {
  const handleSignOut = async () => {
    toast({ title: "Signed Out", description: "Signed out (placeholder—no auth wired)." });
  };

  return (
    <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-12">
      <div className="flex items-center justify-center mb-6">
        <div className="p-4 bg-gradient-to-r from-purple-500 to-pink-500 rounded-2xl">
          <Database className="w-12 h-12 text-white" />
        </div>
      </div>
      <h1 className="text-5xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent mb-4">
        Company Dashboard
      </h1>
      <p className="text-xl text-gray-300 max-w-3xl mx-auto">
        Tabarnam admin dashboard (auth temporarily disabled).
      </p>
      <div className="mt-4 flex items-center justify-center gap-4">
        <Button onClick={handleSignOut} variant="outline" className="text-white border-white/20 hover:bg-white/10">
          Sign Out
        </Button>
      </div>
    </motion.div>
  );
};

export default DashboardHeader;
