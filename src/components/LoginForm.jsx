import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/customSupabaseClient'; // Use the Supabase client for auth functions
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';

const LoginForm = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handleLogin = async (e) => {
    if (e) e.preventDefault(); // Prevent form submit refresh
    setIsSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) {
      toast({ title: 'Success!', description: 'Successfully signed in.' });
    } else {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    }
    setIsSubmitting(false);
  };

  return (
    <motion.form
      onSubmit={handleLogin} // Handle Enter key submit
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="max-w-md mx-auto bg-white/10 backdrop-blur-lg p-8 rounded-2xl border border-white/20"
    >
      <h2 className="text-3xl font-bold text-center text-white mb-6">Access Dashboard</h2>
      <div className="space-y-6">
        <div>
          <label className="block text-gray-300 mb-2" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 bg-gray-900/50 border border-white/20 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label className="block text-gray-300 mb-2" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 bg-gray-900/50 border border-white/20 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            placeholder="••••••••"
          />
        </div>
        <div className="flex flex-col sm:flex-row gap-4">
          <Button
            type="submit" // Trigger form submit on click
            disabled={isSubmitting}
            className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white px-8 py-3 rounded-xl text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-300"
          >
            {isSubmitting ? 'Signing In...' : 'Sign In'}
          </Button>
        </div>
      </div>
    </motion.form>
  );
};

export default LoginForm;