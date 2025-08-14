// src/lib/customSupabaseClient.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Supabase configuration missing. Check .env.local for VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  throw new Error('Supabase URL or Anon Key is required.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);