import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://fcfafysalbrvewhymkce.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjZmFmeXNhbGJydmV3aHlta2NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDkyMjc5NjIsImV4cCI6MjA2NDgwMzk2Mn0.kc9L_31eVUoT7YssTmaaZ3rsof61zj5ry-uKIcBxkoo';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);