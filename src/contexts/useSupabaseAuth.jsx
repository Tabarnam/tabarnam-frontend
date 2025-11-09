import React from 'react';
import { getAdminUser } from '@/lib/azureAuth';

// Dummy context for backward compatibility
export const SupabaseAuthContext = React.createContext(null);

export const useSupabaseAuth = () => {
  const adminUser = getAdminUser();
  return {
    user: adminUser ? { email: adminUser.email } : null,
    loading: false,
  };
};
