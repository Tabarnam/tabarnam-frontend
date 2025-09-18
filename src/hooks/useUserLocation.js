// src/hooks/useUserLocation.js
import { useEffect, useState } from 'react';
import { geocode } from '@/lib/google';

const FALLBACK = { latitude: 34.0983, longitude: -117.8076, label: 'San Dimas, CA 91773', source: 'default' };

export default function useUserLocation() {
  const [location, setLocation] = useState(null);     // { latitude, longitude, label? }
  const [source, setSource]   = useState(null);       // 'device' | 'ip' | 'default'
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;

    const viaDevice = () =>
      new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('no geolocation'));
        navigator.geolocation.getCurrentPosition(
          pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          err => reject(err),
          { enableHighAccuracy: false, timeout: 6000 }
        );
      });

    (async () => {
      try {
        // 1) Device
        const dev = await viaDevice();
        if (cancelled) return;
        const r = await geocode({ lat: dev.lat, lng: dev.lng });
        if (cancelled) return;
        setLocation({ latitude: dev.lat, longitude: dev.lng, label: r?.best?.formatted_address || '' });
        setSource('device');
        return;
      } catch { /* continue */ }

      try {
        // 2) IP
        const r = await geocode({ ip: true });
        if (cancelled) return;
        const loc = r?.best?.location;
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
          setLocation({ latitude: loc.lat, longitude: loc.lng, label: r?.best?.formatted_address || '' });
          setSource('ip');
          return;
        }
      } catch { /* continue */ }

      // 3) Default San Dimas
      if (!cancelled) {
        setLocation({ latitude: FALLBACK.latitude, longitude: FALLBACK.longitude, label: FALLBACK.label });
        setSource('default');
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return { location, source, error };
}
