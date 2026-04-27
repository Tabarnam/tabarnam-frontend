import { Helmet } from 'react-helmet-async';
import { Building2 } from 'lucide-react';

export default function AboutPage() {
  const contactEmail = 'ben@tabarnam.com';
  const description =
    'Tabarnam is a product transparency platform and mobile app that helps consumers and businesses discover where products are manufactured, compare headquarters vs. production locations, explore company profiles, reviews, and tags. Search by brand, product, or location for transparent sourcing insights. Est. 2016 | San Dimas, CA.';

  const orgSchema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Tabarnam',
    url: 'https://tabarnam.com',
    logo: 'https://tabarnam.com/tabarnam.png',
    foundingDate: '2016',
    description,
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'San Dimas',
      addressRegion: 'CA',
      addressCountry: 'US',
    },
  };

  return (
    <>
      <Helmet>
        <title>About Tabarnam – Product Transparency Platform</title>
        <meta name="description" content={description} />
        <link rel="canonical" href="https://tabarnam.com/about" />
        <meta property="og:title" content="About Tabarnam – Product Transparency Platform" />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://tabarnam.com/about" />
        <meta property="og:image" content="https://tabarnam.com/tabarnam.png" />
        <script type="application/ld+json">{JSON.stringify(orgSchema)}</script>
      </Helmet>

      <main className="max-w-3xl mx-auto px-4 py-16">
        <div className="flex items-start gap-4 mb-8">
          <div className="rounded-2xl border border-border bg-card p-3">
            <Building2 size={32} className="text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">About Tabarnam</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Est. 2016 · San Dimas, CA
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Product transparency for consumers and businesses.
            </p>
          </div>
        </div>

        <div className="space-y-8 text-muted-foreground leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">What We Do</h2>
            <p>
              Tabarnam is a product transparency platform and mobile app that helps consumers and
              businesses discover where products are manufactured. We make it easy to compare a
              company's headquarters with its production locations, explore company profiles,
              reviews, and tags, and surface transparent sourcing insights so you can make
              informed decisions about the things you buy and sell.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">How It Works</h2>
            <p>
              Search by brand, product, or location. Tabarnam returns matching companies along
              with their headquarters and manufacturing locations, ranked to help you quickly see
              where things are actually made versus where the company is based. Filter by country,
              state, or city to focus your search on specific regions.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Company Profiles</h2>
            <p>
              Each company in Tabarnam has a profile with manufacturing and headquarters
              locations, product associations, descriptive tags, and community reviews. Profiles
              are designed to give a transparent, at-a-glance picture of where a company operates
              and what it produces.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Mobile App</h2>
            <p>
              Tabarnam is available on mobile so you can check sourcing details on the go —
              whether you are shopping in a store, evaluating a supplier, or researching a brand
              you came across online.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Contact</h2>
            <p>
              Questions, feedback, or partnership inquiries? Reach us at{' '}
              <a className="text-primary underline underline-offset-4" href={`mailto:${contactEmail}`}>
                {contactEmail}
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
