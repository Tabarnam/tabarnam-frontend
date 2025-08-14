// src/pages/ResultsPage.jsx
import React, { useState, useEffect } from 'react';
import { useSupabaseClient } from '@supabase/auth-helpers-react';
import { useToast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { motion } from 'framer-motion';
import ReactTable from 'react-table';
import { Pin } from 'lucide-react'; // For pin icon
import { supabase } from '@/lib/customSupabaseClient'; // If needed for auth

const ResultsPage = () => {
  const supabase = useSupabaseClient();
  const { toast } = useToast();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [sortBy, setSortBy] = useState('Nearest Manufacturing');
  const [expandedRows, setExpandedRows] = useState([]);
  const [translationLang, setTranslationLang] = useState('en'); // Default English
  const [userLocation, setUserLocation] = useState(null); // For distances

  useEffect(() => {
    // Get user location for distances (mi/km based on country)
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, long: pos.coords.longitude }),
      () => toast({ variant: 'destructive', title: 'Location Error', description: 'Unable to get location.' })
    );
  }, []);

  const fetchResults = async () => {
    setLoading(true);
    try {
      let { data, error } = await supabase.from('companies').select('*').ilike('company_name', `%${query}%`);
      if (error) throw error;
      setResults(data || []);
      if (data.length < 20) {
        // Show Dig Deep button logic below
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Search Error', description: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleDigDeep = async () => {
    setLoading(true);
    try {
      // Call xAI for deep search (use your import logic, prompt from scope)
      const deepPrompt = `Deep search ${query}, find more with reviews/Amazon, prioritizing search terms, location preference, smaller businesses.`;
      // Assume callXAI function returns new companies
      const newResults = await callXAI(deepPrompt); // Implement based on your import.js
      // Add to DB
      await supabase.from('companies').upsert(newResults);
      fetchResults(); // Refresh
    } catch (error) {
      toast({ variant: 'destructive', title: 'Dig Deep Error', description: error.message });
    } finally {
      setLoading(false);
    }
  };

  const calculateDistance = (lat1, lon1, lat2, lon2, country) => {
    // Simple haversine formula for distance
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    let distance = R * c;
    // mi for US, UK, etc. (scope list)
    const miCountries = ['United States', 'United Kingdom', 'Liberia', 'Antigua and Barbuda', 'Bahamas', 'Barbados', 'Belize', 'British Virgin Islands', 'Cayman Islands', 'Dominica', 'Falkland Islands', 'Grenada', 'Guam', 'Montserrat', 'Northern Mariana Islands', 'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines', 'Samoa', 'Turks and Caicos Islands', 'United States Virgin Islands', 'Anguilla', 'Gibraltar', 'Isle of Man', 'Jersey', 'Guernsey', 'Saint Helena/Ascension/Tristan da Cunha', 'American Samoa', 'Puerto Rico'];
    if (miCountries.includes(country)) {
      distance *= 0.621371; // km to mi
      return `${distance.toFixed(2)} mi`;
    }
    return `${distance.toFixed(2)} km`;
  };

  const translateText = async (text, lang, companyId, field) => {
    if (lang === 'en') return text;
    // Use Google Translate API (client-side, cache in translations table)
    const apiKey = import.meta.env.GOOGLE_TRANSLATE_API_KEY;
    const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
      method: 'POST',
      body: JSON.stringify({ q: text, target: lang }),
    });
    const data = await response.json();
    const translated = data.data.translations[0].translatedText;
    // Cache in DB
    await supabase.from('translations').upsert({ company_id: companyId, field: field, lang, text: translated });
    return translated;
  };

  const columns = [
    {
      Header: 'Company',
      accessor: 'company_name',
      Cell: ({ row }) => {
        const company = row.original;
        const isExpanded = expandedRows.includes(row.id);
        return (
          <div onClick={() => toggleExpand(row.id)} className="cursor-pointer">
            {company.company_name}
            {isExpanded && (
              <div>
                {company.tagline}
                <a href={company.website_url} target="_blank" rel="noopener noreferrer">{company.website_url}</a> (copy icon)
                {company.amazon_store_url && (
                  <a href={company.amazon_store_url + '?tag=tabarnam-20'} target="_blank" rel="noopener noreferrer">
                    Amazon Store
                  </a>
                )} (hover toast full URL)
                Keywords: {company.company_keywords.join(', ')} (truncate, hover expand, clickable)
                Industries: {company.industry_keywords.join(', ')}
              </div>
            )}
          </div>
        );
      },
    },
    {
      Header: () => <div><Pin className="inline mr-1" /> Home/HQ</div>,
      accessor: 'headquarters',
      Cell: ({ row }) => {
        const company = row.original;
        const isExpanded = expandedRows.includes(row.id);
        const hq = company.headquarters_locations || [];
        return (
          <div>
            {hq[0]?.city} (distance: {userLocation && calculateDistance(userLocation.lat, userLocation.long, hq[0].lat, hq[0].long, hq[0].country)})
            {isExpanded && hq.slice(1).map((loc, i) => <div key={i}>{loc.city} (distance)</div>)}
            {hq.length > 2 && <span>More...</span>}
          </div>
        );
      },
    },
    {
      Header: () => <div><Pin className="inline mr-1" /> Manufacturing</div>,
      accessor: 'manufacturing_locations',
      Cell: ({ row }) => {
        const company = row.original;
        const isExpanded = expandedRows.includes(row.id);
        const manuf = company.manufacturing_locations || [];
        return (
          <div>
            {manuf[0]?.city} (distance: {userLocation && calculateDistance(userLocation.lat, userLocation.long, manuf[0].lat, manuf[0].long, manuf[0].country)})
            {isExpanded && manuf.slice(1).map((loc, i) => <div key={i}>{loc.city} (distance)</div>)}
            {manuf.length > 2 && <span>More...</span>}
          </div>
        );
      },
    },
    {
      Header: 'Stars',
      accessor: 'star_rating',
      Cell: ({ row }) => {
        const company = row.original;
        if (company.star_rating < 4) return <div onMouseOver={() => toast(company.star_explanation)}>Hover for explanation</div>;
        return <div>{company.star_rating} stars (hover: {company.star_explanation})</div>;
      },
    },
  ];

  const toggleExpand = (rowId) => {
    setExpandedRows((prev) => prev.includes(rowId) ? prev.filter(id => id !== rowId) : [...prev, rowId]);
  };

  return (
    <div>
      {/* Homepage search fields */}
      <div>
        <Input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select value={country} onChange={setCountry} /> {/* Options from scope */}
        <Select value={state} onChange={setState} />
        <Input placeholder="City/Postal" value={city} onChange={setCity} />
        <Select value={sortBy} onChange={setSortBy} defaultValue="Nearest Manufacturing" />
        <Button onClick={fetchResults}>Search</Button>
      </div>

      {/* Translation Toggle */}
      <Select value={translationLang} onChange={setTranslationLang} /> {/* Top right */}

      {loading ? <div>Loading...</div> : (
        <ReactTable
          data={results}
          columns={columns}
          defaultPageSize={10}
          className="border"
        />
      )}

      {results.length < 20 && <Button onClick={handleDigDeep}>Dig Deep (hover: Refine your search...)</Button>}
    </div>
  );
};

export default ResultsPage;