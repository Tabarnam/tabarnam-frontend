import React from 'react';
import { UserRoleContext } from '@/contexts/UserRoleContext'; // New import

export const useUserRole = () => {
  const context = React.useContext(UserRoleContext);
  if (context === undefined) {
    throw new Error('useUserRole must be used within a UserRoleProvider');
  }
  return context;
};