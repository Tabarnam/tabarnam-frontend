import React from 'react';

const SupabaseAuthContext = React.createContext(undefined);

export const useSupabaseAuth = () => {
  const context = React.useContext(SupabaseAuthContext);
  if (context === undefined) {
    throw new Error('useSupabaseAuth must be used within a SupabaseAuthProvider');
  }
  return context;
};