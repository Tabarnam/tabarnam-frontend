import { useState, useEffect, useCallback, useRef } from 'react';
// Translation functionality disabled - was using Supabase functions

const useTranslation = (originalText, targetLanguage, isEnabled, companyId, fieldName) => {
    const [translatedText, setTranslatedText] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const hasAttempted = useRef(false);

    const translate = useCallback(async () => {
        if (!isEnabled || !originalText || !targetLanguage || targetLanguage.startsWith('en') || !companyId || !fieldName) {
            setTranslatedText(originalText);
            setLoading(false);
            return;
        }

        if(hasAttempted.current) return;
        hasAttempted.current = true;
        setLoading(true);
        setError(null);

        try {
            const { data, error: functionError } = await supabase.functions.invoke('google-translate', {
              body: { 
                  companyId,
                  fieldName,
                  textToTranslate: originalText,
                  targetLanguage
              },
            });
            if (functionError) throw functionError;
            
            if(data.error) throw new Error(data.error);
            
            setTranslatedText(data.translatedText);
        } catch (err) {
            console.error("Translation failed:", err);
            setError(err.message);
            logError({
                type: 'Translation',
                message: `Failed to translate field '${fieldName}' for company ${companyId}: ${err.message}`,
                company_id: companyId,
                field_name: fieldName,
            });
            setTranslatedText(originalText); // Fallback to original text on error
        } finally {
            setLoading(false);
        }
    }, [originalText, targetLanguage, isEnabled, companyId, fieldName]);

    useEffect(() => {
        translate();
    }, [translate]);

    return { translatedText: translatedText || originalText, loading, error };
};

export default useTranslation;
