// src/components/AdminRoute.jsx
import React from 'react';
import { useSupabaseAuth } from '@/contexts/useSupabaseAuth';
import { useUserRole } from '@/contexts/useUserRole';
import LoginForm from '@/components/LoginForm';

export default function AdminRoute({ children }) {
  const { user, loading: authLoading } = useSupabaseAuth();
  const { userRole, loading: roleLoading } = useUserRole();

  if (authLoading || roleLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-900">
        <img
          src="/tabarnam-icon.png"
          alt="Loading"
          className="w-12 h-12 animate-spin"
        />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-900 p-6 flex items-center justify-center">
        <LoginForm />
      </div>
    );
  }

  if (userRole !== 'admin') {
    return (
      <div className="min-h-screen bg-slate-900 p-6 flex items-center justify-center">
        <div className="text-center text-white">
          <h1 className="text-3xl font-bold mb-4">Access Denied</h1>
          <p className="text-gray-400">You do not have permission to view this page.</p>
          <p className="text-gray-500 text-sm mt-2">If you believe this is an error, please contact support.</p>
        </div>
      </div>
    );
  }

  return children;
}