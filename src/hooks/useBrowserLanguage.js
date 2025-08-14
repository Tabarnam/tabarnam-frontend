import { useState, useEffect } from 'react';

const useBrowserLanguage = () => {
    const getLanguage = () => {
        if (typeof navigator !== 'undefined') {
            return navigator.language || navigator.userLanguage;
        }
        return 'en-US'; // Default fallback
    };

    const [language, setLanguage] = useState(getLanguage());

    useEffect(() => {
        const handleLanguageChange = () => {
            setLanguage(getLanguage());
        };

        window.addEventListener('languagechange', handleLanguageChange);

        return () => {
            window.removeEventListener('languagechange', handleLanguageChange);
        };
    }, []);

    // Return only the primary language code (e.g., 'en' from 'en-US')
    return language.split('-')[0];
};

export default useBrowserLanguage;