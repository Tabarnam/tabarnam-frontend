import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { LogIn, AlertTriangle } from 'lucide-react';
import { useLocation } from 'react-router-dom';

export default function Login() {
  const { search } = useLocation();
  const params = React.useMemo(() => new URLSearchParams(search), [search]);
  const requested = params.get('next') || params.get('returnTo') || '/admin';
  const safePath = requested.startsWith('/') ? requested : '/admin';
  const loginHref = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(safePath)}`;

  const err = params.get('error') || params.get('error_description') || '';
  const hasError = Boolean(err);
  const errorText = params.get('error_description') ||
    (params.get('error') === 'access_denied' ? 'Access denied by Microsoft. Please try a different account or request access.' :
    params.get('error') ? `Login failed: ${params.get('error')}` : '');

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

          {hasError && (
            <div className="text-left rounded-md border border-red-500/40 bg-red-500/10 text-red-200 p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium">Login failed</p>
                <p className="text-xs opacity-90 mt-0.5">{errorText}</p>
              </div>
            </div>
          )}

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
