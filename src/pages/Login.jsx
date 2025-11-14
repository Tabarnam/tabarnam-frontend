import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { LogIn } from 'lucide-react';
import { useLocation } from 'react-router-dom';

export default function Login() {
  const { search } = useLocation();
  const params = React.useMemo(() => new URLSearchParams(search), [search]);
  const requested = params.get('next') || params.get('returnTo') || '/admin';
  const safePath = requested.startsWith('/') ? requested : '/admin';
  const loginHref = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(safePath)}`;

  return (
    <>
      <Helmet>
        <title>Login - Tabarnam Admin</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
        <div className="bg-slate-800 p-6 rounded-lg shadow-lg w-full max-w-sm space-y-5 text-center">
          <div>
            <h2 className="text-white text-xl font-semibold">Admin Sign In</h2>
            <p className="text-gray-400 text-sm mt-2">Use your Microsoft account</p>
          </div>

          <a href={loginHref} className="block">
            <Button type="button" className="w-full">
              <LogIn className="w-5 h-5 mr-2" />
              Sign in with Microsoft
            </Button>
          </a>

          <p className="text-gray-400 text-xs mt-2">You will be redirected back after sign-in.</p>
        </div>
      </div>
    </>
  );
}
