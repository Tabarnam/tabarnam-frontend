
import { useState, useEffect } from 'react';
import { useSearchCache } from './useSearchCache';

const useUserLocation = () => {
    const { getCachedLocation, setCachedLocation } = useSearchCache();
    const [location, setLocation] = useState(getCachedLocation());
    const [error, setError] = useState(null);

    useEffect(() => {
        if (location) return; // Already have location from cache

        if (!navigator.geolocation) {
            setError("Geolocation is not supported by your browser.");
            const defaultLocation = { latitude: 34.0983, longitude: -117.8076, country: 'US' }; // San Dimas, CA
            setLocation(defaultLocation);
            setCachedLocation(defaultLocation);
            return;
        }

        const handleSuccess = (position) => {
            const newLocation = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                country: 'US', // Placeholder, would need reverse geocoding for accuracy
            };
            setLocation(newLocation);
            setCachedLocation(newLocation);
        };

        const handleError = (err) => {
            setError("Unable to retrieve your location. Defaulting to San Dimas, CA.");
            const defaultLocation = { latitude: 34.0983, longitude: -117.8076, country: 'US' }; // San Dimas, CA 91773
            setLocation(defaultLocation);
            setCachedLocation(defaultLocation);
        };

        navigator.geolocation.getCurrentPosition(handleSuccess, handleError, {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0
        });

    }, [location, getCachedLocation, setCachedLocation]);

    return { location, error };
};

export default useUserLocation;
