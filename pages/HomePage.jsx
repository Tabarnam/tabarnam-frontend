
import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import SearchCard from '@/components/home/SearchCard';
import { useSearchCache } from '@/hooks/useSearchCache';

const HomePage = () => {
    const navigate = useNavigate();
    const [isLoading, setIsLoading] = useState(false);
    const { addSearchToCache } = useSearchCache();

    const handleSearch = (searchParams) => {
        setIsLoading(true);
        
        // Clean up params before creating query string
        const cleanParams = Object.entries(searchParams).reduce((acc, [key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                acc[key] = value;
            }
            return acc;
        }, {});
        
        addSearchToCache(cleanParams);

        const queryString = new URLSearchParams(cleanParams).toString();
        navigate(`/results?${queryString}`);
    };

    return (
        <>
            <Helmet>
                <title>Tabarnam</title>
                <meta name="description" content="Discover products with transparent origins. Search for companies by location, rating, and more." />
            </Helmet>
            <div className="min-h-screen w-full flex flex-col p-4 bg-white relative">
                <header className="absolute top-0 left-0 right-0 pt-8 flex justify-center">
                     <a href="/">
                        <motion.div whileHover={{ scale: 1.05 }} transition={{ type: "spring", stiffness: 300 }}>
                            <img src="https://storage.googleapis.com/hostinger-horizons-assets-prod/7a52e996-8cb5-4576-916e-e398d620ccbb/b264cc6fba83562cdb682e19318806ef.png" alt="Tabarnam Logo" className="h-24 md:h-40 mx-auto" />
                        </motion.div>
                    </a>
                </header>

                <main className="flex-grow flex flex-col items-center justify-center w-full pt-40 md:pt-0">
                    <motion.div
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5 }}
                        className="text-center mb-8"
                    >
                        <h1 className="sr-only">Tabarnam</h1>
                        <p className="text-lg text-gray-600">
                            Discover products with transparent origins
                        </p>
                    </motion.div>
                    
                    <SearchCard onSearch={handleSearch} isLoading={isLoading} />
                </main>
                
                <footer className="w-full py-6 text-center text-gray-500 text-sm">
                    © {new Date().getFullYear()} Tabarnam. All rights reserved.
                    <div className="mt-1">
                        <a href="#" className="hover:text-gray-800 transition-colors">Privacy Policy</a>
                        <span className="mx-2">·</span>
                        <a href="#" className="hover:text-gray-800 transition-colors">Terms of Service</a>
                    </div>
                </footer>
            </div>
        </>
    );
};

export default HomePage;
