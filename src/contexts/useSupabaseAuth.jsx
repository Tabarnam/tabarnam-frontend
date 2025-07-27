import React from 'react';

const SupabaseAuthContext = React.createContext(null);

export const useSupabaseAuth = () => {
  const context = React.useContext(SupabaseAuthContext);
  if (context === null) {
    throw new Error('useSupabaseAuth must be used within a SupabaseAuthProvider');
  }
  return context;
};