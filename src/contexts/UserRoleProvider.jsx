import React from 'react';

// Dummy provider - user roles are managed via localStorage in azureAuth
export const UserRoleProvider = ({ children }) => {
  // Simply pass through children
  return <>{children}</>;
};
