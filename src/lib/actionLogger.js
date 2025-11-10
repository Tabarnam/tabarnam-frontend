// Action logging disabled (was using Supabase)

export const logAction = async (actionDetails) => {
  try {
    console.log('Action logged:', actionDetails);
    // In production, replace with actual logging (Sentry, DataDog, etc.)
    return { id: null };
  } catch (error) {
    console.error('Action logging failed:', error);
    return null;
  }
};
