import { useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useLocation } from 'react-router-dom';
import { Compass } from 'lucide-react';

export default function HelpPage() {
  const updatedAt = 'May 3, 2026';
  const contactEmail = 'duh@tabarnam.com';
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) {
      // Plain /help arrival (e.g. via footer "How it works" link) — start at top.
      // React Router doesn't reset scroll on route change by default.
      try { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); } catch { window.scrollTo(0, 0); }
      return;
    }
    const id = hash.slice(1);
    const t = setTimeout(() => {
      try {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch {}
    }, 50);
    return () => clearTimeout(t);
  }, [hash]);

  return (
    <>
      <Helmet>
        <title>How Tabarnam Works – Help</title>
        <meta
          name="description"
          content="A quick guide to searching Tabarnam, targeting a location, sorting results, reading a company profile, sharing, and giving feedback."
        />
      </Helmet>

      <main className="max-w-3xl mx-auto px-4 py-16">
        <div className="flex items-start gap-4 mb-8">
          <div className="rounded-2xl border border-border bg-card p-3">
            <Compass size={32} className="text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">How Tabarnam Works</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Last updated: {updatedAt}
            </p>
            <p className="text-sm text-muted-foreground mt-2 italic">
              ...but where was it made?
            </p>
          </div>
        </div>

        <nav aria-label="On this page" className="mb-10 rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            On this page
          </p>
          <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <li><a href="#quick-start" className="text-primary underline underline-offset-4">Quick start</a></li>
            <li><a href="#searching" className="text-primary underline underline-offset-4">Searching</a></li>
            <li><a href="#location" className="text-primary underline underline-offset-4">Targeting a location</a></li>
            <li><a href="#sorting" className="text-primary underline underline-offset-4">Sorting and filtering</a></li>
            <li><a href="#qq" className="text-primary underline underline-offset-4">The QQ score</a></li>
            <li><a href="#row" className="text-primary underline underline-offset-4">Reading a result</a></li>
            <li><a href="#profile" className="text-primary underline underline-offset-4">Company profile</a></li>
            <li><a href="#share" className="text-primary underline underline-offset-4">Sharing</a></li>
            <li><a href="#feedback" className="text-primary underline underline-offset-4">Feedback</a></li>
            <li><a href="#privacy" className="text-primary underline underline-offset-4">Privacy</a></li>
          </ul>
        </nav>

        <div className="space-y-10 text-muted-foreground leading-relaxed">
          <section id="quick-start">
            <h2 className="text-xl font-semibold text-foreground mb-3">Quick start</h2>
            <p className="mb-3">
              Tabarnam helps you find products and the companies behind them, with their headquarters and
              manufacturing locations on display. There are three ways to start a search:
            </p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>Type a <strong className="text-foreground">company name</strong> (for example, <em>Jelly Belly</em>).</li>
              <li>Type a <strong className="text-foreground">product or industry</strong> (for example, <em>honey</em>, <em>candles</em> or <em>organic bar soap</em>).</li>
              <li>Leave the search empty and just <strong className="text-foreground">enter a location</strong> to browse what is nearby.</li>
            </ul>
          </section>

          <section id="searching">
            <h2 className="text-xl font-semibold text-foreground mb-3">Searching</h2>
            <p className="mb-3">
              As you type, suggestions appear below the search bar. Product and industry completions are
              listed first, followed by matching company names (marked with a small <em>company</em> tag).
              Click a suggestion to run that search.
            </p>
            <p className="mb-3">
              <strong className="text-foreground">Recent searches.</strong> Click the empty search bar to see
              your recent searches. Use the <em>Clear recent searches</em> link at the bottom of the list to remove them.
            </p>
            <p>
              <strong className="text-foreground">Back and forward.</strong> The arrow buttons to the left of the
              search bar move through your search history within this session. The chevron between them opens a list
              of every search you have run.
            </p>
          </section>

          <section id="location">
            <h2 className="text-xl font-semibold text-foreground mb-3">Targeting a location</h2>
            <p className="mb-3">
              The location row sits below the search bar. Fill in any combination of fields to orient
              results around that place:
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mb-3">
              <li><strong className="text-foreground">City or postal code</strong> — A postal code by itself is enough to detect the country.</li>
              <li><strong className="text-foreground">State or province</strong> — autocompletes against the selected country.</li>
              <li><strong className="text-foreground">Country</strong> — accepts the country name or code.</li>
            </ul>
            <p>
              You can search by location alone. Leave the search bar empty, enter a city or country, and
              Tabarnam will return companies oriented to that place.
            </p>
          </section>

          <section id="sorting">
            <h2 className="text-xl font-semibold text-foreground mb-3">Sorting and filtering</h2>
            <p className="mb-3">
              Open the dropdown to the left of the location row to sort and filter:
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mb-3">
              <li><strong className="text-foreground">Nearest manufacturing</strong> — closest manufacturing site to your location.</li>
              <li><strong className="text-foreground">Nearest headquarters</strong> — closest HQ to your location.</li>
              <li><strong className="text-foreground">Highest rated</strong> — sorted by QQ score.</li>
              <li><strong className="text-foreground">In country manufacturing</strong> — only companies that manufacture in country.</li>
              <li><strong className="text-foreground">In country headquarters</strong> — only companies headquartered in country.</li>
              <li><strong className="text-foreground">Amazon link</strong> — only companies with some products available on Amazon.</li>
            </ul>
            <p>
              <strong className="text-foreground">Sort by clicking a column header.</strong> Click the <em>HQ</em> or
              <em> Manufacturing</em> header on the results table to re-sort existing results by proximity to your specified location.
              If no location is set, results are sorted by proximity to your browser's location. Click the <em>QQ</em> header to sort by score.
            </p>
          </section>

          <section id="qq">
            <h2 className="text-xl font-semibold text-foreground mb-3">The QQ score</h2>
            <p className="mb-3">
              QQ is a combined <strong className="text-foreground">quantity and quality</strong> measure of the
              information we have on a company — how complete and verifiable its locations, sourcing, and reputation
              data are. It is not a user review score.
            </p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li><strong className="text-foreground">Hover the QQ score on a row</strong> to see the numeric value.</li>
              <li><strong className="text-foreground">Hover the QQ column header</strong> to see a short explanation.</li>
            </ul>
          </section>

          <section id="row">
            <h2 className="text-xl font-semibold text-foreground mb-3">Reading a result</h2>
            <p className="mb-3">
              Each row gives you the essentials at a glance. A few interactions worth knowing:
            </p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li><strong className="text-foreground">Hover the company logo</strong> to see an image of the company's homepage.</li>
              <li><strong className="text-foreground">Click the logo or company name</strong> to open the company's website in a new tab.</li>
              <li><strong className="text-foreground">Click any product or industry tag</strong> to start a fresh search for that term.</li>
              <li>Distances are shown in miles or kilometers based on your country.</li>
            </ul>
          </section>

          <section id="profile">
            <h2 className="text-xl font-semibold text-foreground mb-3">Expanded company profile</h2>
            <p className="mb-3">
              Click anywhere on a row to expand it. The expanded profile shows:
            </p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>Every headquarters location and every manufacturing location.</li>
              <li>The reputation and quality considerations that make up QQ.</li>
              <li>Industries and products associated with the company (each one is clickable to start a new search).</li>
              <li>Reviews from external sources, with links back to the original review.</li>
              <li>Social media links and an Amazon link when available.</li>
            </ul>
          </section>

          <section id="share">
            <h2 className="text-xl font-semibold text-foreground mb-3">Sharing</h2>
            <p className="mb-3">
              Use the share button to send a link to a search results page or a single company profile. The share
              dialog includes:
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mb-3">
              <li><strong className="text-foreground">Copy link</strong> — copy the URL to your clipboard.</li>
              <li><strong className="text-foreground">QR code</strong> — show a scannable QR for handing off to a phone.</li>
              <li><strong className="text-foreground">Recent contacts</strong> — quick-send via your address book.</li>
              <li><strong className="text-foreground">Apps</strong> — Outlook, Gmail, Microsoft Teams, X, WhatsApp, Facebook, LinkedIn, iCloud, Microsoft 365 Copilot, and other apps installed on your device.</li>
            </ul>
            <p>
              Search links preserve your query, location, sort, and filters, so the recipient sees the same results
              you saw.
            </p>
          </section>

          <section id="feedback">
            <h2 className="text-xl font-semibold text-foreground mb-3">Feedback</h2>
            <p className="mb-3">
              The feedback button lives in the corner of every page. Open it to:
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mb-3">
              <li>Propose a company we should add.</li>
              <li>Report a problem or incorrect data.</li>
              <li>Suggest a site improvement.</li>
              <li>Send a general inquiry.</li>
            </ul>
            <p>
              You can also email us directly at{' '}
              <a className="text-primary underline underline-offset-4" href={`mailto:${contactEmail}`}>
                {contactEmail}
              </a>
              .
            </p>
          </section>

          <section id="privacy">
            <h2 className="text-xl font-semibold text-foreground mb-3">Privacy</h2>
            <p>
              Tabarnam does not sell personal information and does not require an account for basic search.
              Read the full{' '}
              <Link to="/privacy" className="text-primary underline underline-offset-4">Privacy Policy</Link>
              {' '}for details on what is processed and how.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
