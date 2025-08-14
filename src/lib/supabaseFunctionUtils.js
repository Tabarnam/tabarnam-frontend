
import { supabase } from '@/lib/customSupabaseClient';

/**
 * Creates the required headers for invoking a Supabase Edge Function.
 * It ensures every request is authenticated with both the Authorization Bearer token
 * (if a user is logged in) and the public anon key. This dual-header approach
 * ensures the request can pass through all of Supabase's proxy layers.
 * @returns {Promise<object>} An object containing the headers.
 */
export const getFunctionHeaders = async () => {
  const { data: { session } } = await supabase.auth.getSession();
  
  const accessToken = session?.access_token || supabase.supabaseKey;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'apikey': supabase.supabaseKey,
  };
  
  return headers;
};
