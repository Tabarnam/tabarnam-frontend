// src/lib/customSupabaseClient.js
// Supabase has been removed from this project.
// This stub prevents runtime errors if any older imports still exist.
// Migrate all functionality to Cosmos DB instead.

const safeStub = {
  from: () => ({
    select: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Cosmos DB' } }),
    insert: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Cosmos DB' } }),
    upsert: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Cosmos DB' } }),
    delete: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Cosmos DB' } }),
    update: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Cosmos DB' } }),
    eq: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Cosmos DB' } }),
    single: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Cosmos DB' } }),
  }),
  auth: {
    getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signInWithPassword: () => Promise.resolve({ error: { message: 'Supabase auth removed' } }),
  },
  rpc: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Cosmos DB' } }),
  functions: {
    invoke: () => Promise.resolve({ data: null, error: { message: 'Supabase removed - use Azure Functions' } }),
  },
};

export const supabase = safeStub;
