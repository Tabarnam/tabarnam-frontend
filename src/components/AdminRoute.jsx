
import React from 'react';
import { useAuth } from '@/contexts/SupabaseAuthContext';
import { useUserRole } from '@/contexts/UserRoleContext';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import LoginForm from '@/components/LoginForm';

const AdminRoute = ({ children }) => {
  const { user, loading: authLoading } = useAuth();
  const { userRole, loading: roleLoading } = useUserRole();

  if (authLoading || roleLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-900">
        <Loader2 className="w-12 h-12 text-white animate-spin" />
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
};

export default AdminRoute;
