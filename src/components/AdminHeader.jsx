import React from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getAdminUser, logoutAdmin } from '@/lib/azureAuth';

export default function AdminHeader() {
  const navigate = useNavigate();
  const user = getAdminUser();

  const handleLogout = () => {
    logoutAdmin();
    navigate('/login');
  };

  return (
    <div className="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold text-white">Tabarnam Admin</h1>
        {user && <p className="text-gray-400 text-sm">Logged in as: {user.email}</p>}
      </div>
      <Button
        onClick={handleLogout}
        variant="outline"
        className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
      >
        <LogOut className="w-4 h-4 mr-2" />
        Logout
      </Button>
    </div>
  );
}
