
import React, { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/SupabaseAuthContext';
import { supabase } from '@/lib/customSupabaseClient';

const UserRoleContext = createContext(null);

export const UserRoleProvider = ({ children }) => {
  const { user, loading: authLoading } = useAuth();
  const [userRole, setUserRole] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchUserRole = useCallback(async (currentUser) => {
    if (!currentUser) {
      setUserRole(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const { data, error, status } = await supabase
        .from('profiles')
        .select(`role`)
        .eq('id', currentUser.id)
        .single();

      if (error && status !== 406) {
        throw error;
      }

      setUserRole(data ? data.role : 'viewer');
    } catch (error) {
      console.error('Error fetching user role:', error);
      setUserRole('viewer'); // Default to a safe role on error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Only fetch role if the auth state is resolved and we have a user
    if (!authLoading) {
      fetchUserRole(user);
    }
  }, [user, authLoading, fetchUserRole]);

  const value = useMemo(() => ({
    userRole,
    loading: authLoading || loading,
  }), [userRole, authLoading, loading]);

  return (
    <UserRoleContext.Provider value={value}>
      {children}
    </UserRoleContext.Provider>
  );
};

export const useUserRole = () => {
  const context = useContext(UserRoleContext);
  if (context === null) {
    throw new Error('useUserRole must be used within a UserRoleProvider');
  }
  return context;
};
