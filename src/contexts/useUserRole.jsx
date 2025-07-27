import React, { useContext } from 'react';

const UserRoleContext = React.createContext(null);

export const useUserRole = () => {
  const context = useContext(UserRoleContext);
  if (context === null) {
    throw new Error('useUserRole must be used within a UserRoleProvider');
  }
  return context;
};