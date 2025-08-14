// src/GeocodingMap.js
import React, { useState, useEffect } from 'react';
import { GoogleMap, LoadScript, Marker } from '@react-google-maps/api';
import axios from 'axios';

const GeocodingMap = ({ companies }) => {
  const [userLocation, setUserLocation] = useState({ lat: null, lng: null, address: '', countryCode: '' });
  const [userInput, setUserInput] = useState('');
  const [sortedCompanies, setSortedCompanies] = useState([]);

  // Countries/territories using miles (from guidance/search: US, UK, LR + territories)
  const milesCountries = new Set([
    'US', 'GB', 'LR', 'AG', 'BS', 'BB', 'BZ', 'VG', 'KY', 'DM', 'FK', 'GD', 'GU', 'MS', 'MP', 'KN', 'LC', 'VC', 'WS', 'TC', 'VI', 'AI', 'GI', 'IM', 'JE', 'GG', 'SH', 'AS', 'PR'
  ]);

  // Haversine formula for distance in km
  const haversineDistance = (lat1, lon1, lat2, lon2) => {
    const toRad = (deg) => deg * (Math.PI / 180);
    const R = 6371; // Earth's radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // Get default user location + country from IP
  useEffect(() => {
    const fetchIPLocation = async () => {
      try {
        const response = await axios.get('https://ip-api.com/json');
        const { lat, lon, countryCode } = response.data;
        setUserLocation({ lat, lng: lon, address: 'IP-based location', countryCode });
      } catch (error) {
        console.error('IP location error:', error);
        setUserLocation({ lat: 45.0, lng: -75.0, address: 'Default (Canada Central)', countryCode: 'CA' }); // Fallback to km country
      }
    };
    fetchIPLocation();
  }, []);

  // Geocode user input + extract country code
  const geocodeUserInput = async () => {
    if (!userInput) return;
    try {
      const response = await axios.get(`${import.meta.env.VITE_GOOGLE_GEOCODING_API_URL}?address=${encodeURIComponent(userInput)}&key=${import.meta.env.GOOGLE_GEOCODING_API_KEY}`);
      const { lat, lng } = response.data.results[0]?.geometry.location || {};
      // Extract country code (short_name from address_components)
      const countryComponent = response.data.results[0]?.address_components.find(c => c.types.includes('country'));
      const countryCode = countryComponent?.short_name || 'UNKNOWN';
      if (lat && lng) {
        setUserLocation({ lat, lng, address: userInput, countryCode });
      } else {
        alert('Invalid address');
      }
    } catch (error) {
      console.error('Geocoding error:', error);
      alert('Geocoding failed');
    }
  };

  // Calculate distances, sort, and apply miles/km based on country
  useEffect(() => {
    if (userLocation.lat && userLocation.lng) {
      const useMiles = milesCountries.has(userLocation.countryCode);
      const conversionFactor = useMiles ? 0.621371 : 1; // km to mi if needed
      const unit = useMiles ? 'mi' : 'km';

      const updatedCompanies = companies.map(company => {
        // HQ distance
        const hqDistKm = haversineDistance(userLocation.lat, userLocation.lng, company.lat || 0, company.long || 0);
        const hqDistance = (hqDistKm * conversionFactor).toFixed(2) + ' ' + unit;

        // Manufacturing distances (array, calculate per location)
        const manuDistances = company.manufacturing_locations.map(loc => {
          // Assume each loc has its own lat/lng (from import: add manu_lats, manu_lngs arrays in backend)
          // For simplicity, geocode if not stored (but do in backend for efficiency)
          const manuLat = company.manu_lats?.[0] || 0; // Example; adjust for multiple
          const manuLng = company.manu_lngs?.[0] || 0;
          const manuDistKm = haversineDistance(userLocation.lat, userLocation.lng, manuLat, manuLng);
          return (manuDistKm * conversionFactor).toFixed(2) + ' ' + unit;
        }).join(', ');

        return { ...company, hqDistance, manuDistances, distanceKm: hqDistKm }; // Store km for sorting
      }).sort((a, b) => a.distanceKm - b.distanceKm); // Sort by closest (HQ)

      setSortedCompanies(updatedCompanies);
    }
  }, [userLocation, companies]);

  return (
    <div>
      <h2>Company Map by Proximity</h2>
      <input
        type="text"
        value={userInput}
        onChange={(e) => setUserInput(e.target.value)}
        placeholder="Enter your location (or use IP default)"
      />
      <button onClick={geocodeUserInput}>Set Location</button>
      <p>Current Reference: {userLocation.address} (Country: {userLocation.countryCode}, Unit: {milesCountries.has(userLocation.countryCode) ? 'mi' : 'km'})</p>

      <LoadScript googleMapsApiKey={import.meta.env.GOOGLE_GEOCODING_API_KEY}>
        <GoogleMap mapContainerStyle={{ height: "400px", width: "100%" }} center={{ lat: userLocation.lat || 45.0, lng: userLocation.lng || -75.0 }} zoom={4}>
          {sortedCompanies.map(c => (
            <Marker key={c.company_name} position={{ lat: c.lat || 0, lng: c.long || 0 }} title={`${c.company_name} - HQ: ${c.hqDistance}`} />
          ))}
        </GoogleMap>
      </LoadScript>

      <h3>Sorted Companies by Distance</h3>
      <ul>
        {sortedCompanies.map(c => (
          <li key={c.company_name}>
            {c.company_name} - HQ Distance: {c.hqDistance} (Location: {c.headquarters_location}) 
            <br /> Manufacturing Distances: {c.manuDistances || 'N/A'} (Locations: {c.manufacturing_locations.join(', ')})
          </li>
        ))}
      </ul>
    </div>
  );
};

export default GeocodingMap;