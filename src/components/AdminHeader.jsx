import React from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Logo from "@/assets/tabarnam.png";

const navLinkClass = ({ isActive }) =>
  cn(
    "inline-flex items-center rounded-md px-3 py-2 text-sm font-medium transition",
    isActive ? "bg-slate-800 text-white" : "text-slate-200 hover:bg-slate-800 hover:text-white"
  );

export default function AdminHeader() {
  const navigate = useNavigate();

  const handleLogout = () => {
    const postLogout = encodeURIComponent("/login");
    window.location.href = `/.auth/logout?post_logout_redirect_uri=${postLogout}`;
    navigate("/login");
  };

  return (
    <div className="bg-slate-900 border-b border-slate-800">
      <div className="p-4 flex items-end justify-between gap-4">
        <div className="flex items-end gap-4">
          <Link to="/" className="flex items-end" aria-label="Tabarnam home">
            <img src={Logo} alt="Tabarnam" className="h-[5rem] w-auto" />
          </Link>
          <div className="flex flex-col gap-2">
            <span className="text-2xl font-bold text-white">Admin</span>
            <nav className="flex flex-wrap items-center gap-1">
              <NavLink to="/admin" end className={navLinkClass}>
                Companies
              </NavLink>
              <NavLink to="/admin/import" className={navLinkClass}>
                Import
              </NavLink>
              <NavLink to="/admin/diagnostics" className={navLinkClass}>
                Diagnostics
              </NavLink>
            </nav>
          </div>
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
    </div>
  );
}
