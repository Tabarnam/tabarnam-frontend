// src/components/FeedbackWidget.jsx
import React from 'react';
import { Copy } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { useLocation } from 'react-router-dom';

const EMAIL = 'duh@tabarnam.com';

export default function FeedbackWidget() {
  const { pathname } = useLocation();
  // Hide on admin pages
  if (pathname.startsWith('/admin')) return null;

  const { toast } = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(EMAIL);
      toast({ title: 'Copied', description: EMAIL });
    } catch { /* no-op */ }
  };

  return (
    <div className="fixed top-3 right-3 z-50 bg-white/90 backdrop-blur border rounded-full px-3 py-1.5 shadow flex items-center gap-2">
      <span className="text-sm text-gray-700">Reach us:</span>
      <a href={`mailto:${EMAIL}`} className="text-sm font-medium text-blue-700 hover:underline">
        {EMAIL}
      </a>
      <button onClick={copy} className="p-1 rounded hover:bg-gray-100" aria-label="Copy email">
        <Copy size={16} />
      </button>
    </div>
  );
}
