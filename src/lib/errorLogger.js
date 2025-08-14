
import { supabase } from '@/lib/customSupabaseClient';

/**
 * Logs an error to the Supabase 'errors' table.
 * The database has a trigger that will automatically send an email alert.
 * @param {object} errorDetails - The details of the error.
 * @param {string} errorDetails.type - The type of error (e.g., 'Geolocation', 'xAI Import', 'Supabase Insert').
 * @param {string} [errorDetails.company_id] - The ID of the company related to the error, if applicable.
 * @param {string} [errorDetails.field_name] - The specific field related to the error.
 * @param {string} errorDetails.message - A descriptive error message.
 */
export const logError = async (errorDetails) => {
  try {
    // Log the error to the database. A trigger (`on_new_error_send_email`)
    // will handle invoking the `send-error-alert` edge function.
    const { data: errorLog, error: dbError } = await supabase
      .from('errors')
      .insert([
        {
          type: errorDetails.type,
          company_id: errorDetails.company_id,
          field_name: errorDetails.field_name,
          message: errorDetails.message,
          resolved: false,
        },
      ])
      .select()
      .single();

    if (dbError) {
      console.error('Failed to log error to database:', dbError);
      // Fallback if DB logging fails
      throw new Error(`Primary error logging failed: ${dbError.message}`);
    }

    return errorLog;
  } catch (error) {
    console.error('Error logging process failed:', error);
    // This is a critical failure in the logging system itself.
    // In a production environment, you might have a secondary, simpler logging mechanism here.
  }
};
