import React, { useState } from 'react';
import Head from 'next/head';
import { motion } from 'framer-motion';
import { useRouter } from 'next/router';

import SearchCard from '@/components/home/SearchCard';
import { useSearchCache } from '@/hooks/useSearchCache';

const HomePage = () => {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const { addSearchToCache } = useSearchCache();

  const handleSearch = (searchParams) => {
    setIsLoading(true);

    const cleanParams = Object.entries(searchParams).reduce((acc, [key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        acc[key] = value;
      }
      return acc;
    }, {});

    addSearchToCache(cleanParams);

    const queryString = new URLSearchParams(cleanParams).toString();
    router.push(`/results?${queryString}`);
  };

  return (
    <>
      <Head>
        <title>Tabarnam – Transparent Product Origins</title>
        <meta name="description" content="Search products and discover where they’re made." />
      </Head>

      <motion.main
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="min-h-screen bg-white dark:bg-black transition-colors"
      >
        <div className="container mx-auto px-4 py-10">
          <SearchCard onSearch={handleSearch} isLoading={isLoading} />
        </div>
      </motion.main>
    </>
  );
};

export default HomePage;
