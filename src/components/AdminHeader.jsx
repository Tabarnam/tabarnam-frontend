import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Logo from '@/assets/tabarnam.png';

export default function AdminHeader() {
  const navigate = useNavigate();

  const handleLogout = () => {
    const postLogout = encodeURIComponent('/login');
    window.location.href = `/.auth/logout?post_logout_redirect_uri=${postLogout}`;
    navigate('/login');
  };

  return (
    <div className="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between">
      <div className="flex items-center">
        <Link to="/" className="flex items-center" aria-label="Tabarnam home">
          <img
            src={Logo}
            alt="Tabarnam"
            className="h-8 w-auto mr-2"
          />
          <span className="text-2xl font-bold text-white">Admin</span>
        </Link>
        <Link
          to="/admin/xai-bulk-import"
          className="ml-10 text-sm text-teal-200 hover:text-white underline"
        >
          Deep Dive Tool
        </Link>
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
