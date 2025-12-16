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
    <div className="bg-slate-900 border-b border-slate-800 p-4 flex items-end justify-between">
      <div className="flex items-end w-full">
        <Link to="/" className="flex items-end" aria-label="Tabarnam home">
          <img
            src={Logo}
            alt="Tabarnam"
            className="h-[5rem] w-auto mr-4"
          />
        </Link>
        <span className="ml-5 text-2xl font-bold text-white">Admin</span>
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
