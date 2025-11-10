import React from 'react';

// Dummy context - user role functionality disabled
export const UserRoleContext = React.createContext(null);

export const useUserRole = () => {
  return {
    userRole: 'admin', // Default to admin since we're using localStorage auth
    loading: false,
  };
};
