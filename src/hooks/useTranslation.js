import { useState } from 'react';

// Translation functionality disabled (was using Supabase functions)
// Returns original text as fallback

const useTranslation = (originalText) => {
  const [translatedText] = useState(originalText);
  const [loading] = useState(false);
  const [error] = useState(null);

  return { 
    translatedText: translatedText || originalText, 
    loading, 
    error 
  };
};

export default useTranslation;
