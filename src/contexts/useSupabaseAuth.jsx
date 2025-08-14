// src/contexts/useSupabaseAuth.jsx
import React from 'react';
import { SupabaseAuthContext } from '@/contexts/SupabaseAuthContext';

export const useSupabaseAuth = () => {
  const context = React.useContext(SupabaseAuthContext);
  if (context === undefined) {
    throw new Error('useSupabaseAuth must be used within a SupabaseAuthProvider');
  }
  return context;
};