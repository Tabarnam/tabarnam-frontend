/**
 * Error logging disabled (was using Supabase).
 * Logs errors to console as fallback.
 * @param {object} errorDetails - The details of the error.
 */
export const logError = async (errorDetails) => {
  try {
    console.error('Error logged:', errorDetails);
    // In production, replace with actual error tracking (Sentry, etc.)
    return { id: null };
  } catch (error) {
    console.error('Error logging failed:', error);
  }
};
