import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { loginAdmin, getAuthorizedAdminEmails } from '@/lib/azureAuth';
import { useToast } from '@/components/ui/use-toast';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, Lock, LogIn } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const authorizedEmails = getAuthorizedAdminEmails();

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);

    const result = loginAdmin(email, password);
    setLoading(false);

    if (result.success) {
      toast({
        title: 'Login Successful',
        description: `Welcome, ${email}!`,
      });
      navigate('/admin');
    } else {
      toast({
        title: 'Login Failed',
        description: result.error || 'An error occurred',
        variant: 'destructive',
      });
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleLogin(e);
    }
  };

  return (
    <>
      <Helmet>
        <title>Login - Tabarnam Admin</title>
      </Helmet>
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
        <form
          onSubmit={handleLogin}
          className="bg-slate-800 p-6 rounded-lg shadow-lg w-full max-w-sm space-y-5"
        >
          <div className="text-center">
            <Lock className="w-8 h-8 text-white mx-auto mb-1" />
            <h2 className="text-white text-xl font-semibold">Admin Login</h2>
            <p className="text-gray-400 text-sm mt-2">Tabarnam Administration</p>
          </div>

          <div className="bg-slate-700/50 border border-slate-600 rounded p-3 text-sm">
            <p className="text-gray-300 font-semibold mb-2">Authorized Emails:</p>
            <ul className="text-gray-400 space-y-1">
              {authorizedEmails.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1">Email</label>
            <Input
              type="email"
              placeholder="duh@tabarnam.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-slate-700 text-white border-slate-600"
              onKeyDown={handleKeyDown}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-300 mb-1">Password</label>
            <Input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="bg-slate-700 text-white border-slate-600"
              onKeyDown={handleKeyDown}
            />
            <p className="text-gray-500 text-xs mt-2">
              (Temporary: any password works for authorized emails)
            </p>
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="animate-spin w-5 h-5 mr-2" />
                Logging in...
              </>
            ) : (
              <>
                <LogIn className="w-5 h-5 mr-2" />
                Log In
              </>
            )}
          </Button>

          <p className="text-gray-400 text-xs text-center mt-4">
            💡 For production, integrate with Azure AD or Microsoft Entra ID
          </p>
        </form>
      </div>
    </>
  );
}
