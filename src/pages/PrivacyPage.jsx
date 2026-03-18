import { Helmet } from 'react-helmet-async';
import { ShieldCheck } from 'lucide-react';

export default function PrivacyPage() {
  return (
    <>
      <Helmet>
        <title>Privacy – Tabarnam</title>
        <meta name="description" content="Tabarnam's position on user data" />
      </Helmet>

      <main className="max-w-3xl mx-auto px-4 py-16">
        <div className="flex items-center gap-3 mb-8">
          <ShieldCheck size={32} className="text-primary" />
          <h1 className="text-3xl font-bold">Not Collecting Your Data</h1>
        </div>

        <p className="text-lg text-muted-foreground leading-relaxed">
          We do not collect, track, or sell any user-specific personal data. No cookies for behavioral tracking. No profiling. No third-party trackers. Just pure, private commerce.
        </p>
      </main>
    </>
  );
}
