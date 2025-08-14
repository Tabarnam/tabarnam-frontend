import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/useSupabaseAuth';

export const logAction = async (actionDetails) => {
    // This is a placeholder for user ID. In a real app, this would come from the auth context.
    const { user } = useAuth.getState ? useAuth.getState() : { user: null };

    try {
        const { data, error } = await supabase
            .from('action_history')
            .insert({
                ...actionDetails,
                user_id: user?.id, 
            })
            .select()
            .single();
        
        if (error) throw error;
        
        return data; // Return the created action log
    } catch (error) {
        console.error("Failed to log action:", error.message);
        // We don't want to throw here as logging is a secondary concern
        return null;
    }
};