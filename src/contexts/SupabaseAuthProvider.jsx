import React from 'react';

// Dummy provider - Supabase auth has been removed
// Use azureAuth library instead for login/logout

export const SupabaseAuthProvider = ({ children }) => {
  // Simply pass through children without initializing Supabase
  return <>{children}</>;
};
