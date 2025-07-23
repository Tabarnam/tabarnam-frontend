import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet';
import { supabase } from '@/lib/customSupabaseClient';
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

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (error) {
      toast({
        title: 'Login Failed',
        description: error.message,
        variant: 'destructive',
      });
    } else {
      navigate('/admin');
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
          </div>
          <div>
            <label className="block text-sm text-gray-300 mb-1">Email</label>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-slate-700 text-white"
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
              className="bg-slate-700 text-white"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="animate-spin w-5 h-5 mr-2" /> : <LogIn className="w-5 h-5 mr-2" />}
            {loading ? 'Logging in...' : 'Log In'}
          </Button>
        </form>
      </div>
    </>
  );
}
