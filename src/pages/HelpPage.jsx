import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { Compass, Play } from 'lucide-react';

export default function HelpPage() {
  const contactEmail = 'duh@tabarnam.com';

  return (
    <>
      <Helmet>
        <title>How Tabarnam Works – Help</title>
        <meta
          name="description"
          content="A quick guide to searching Tabarnam, targeting a location, sorting results, reading a company profile, adding reviews, saving bookmarks, sharing, and giving feedback."
        />
      </Helmet>

      <main className="max-w-3xl mx-auto px-4 py-16">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl border border-border bg-card p-3">
              <Compass size={32} className="text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">How Tabarnam Works</h1>
              <p className="text-sm text-muted-foreground mt-2 italic">
                ...but where was it made?
              </p>
            </div>
          </div>
          <Link
            to="/?tour=1"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors whitespace-nowrap"
          >
            <Play size={14} className="text-primary" />
            Take the tour
          </Link>
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
            <li><a href="#reviews" className="text-primary underline underline-offset-4">Reviews</a></li>
            <li><a href="#bookmarks" className="text-primary underline underline-offset-4">Bookmarks</a></li>
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
              <li>Reviews from external sources and from the Tabarnam community.</li>
              <li>Social media links and an Amazon link when available.</li>
            </ul>
          </section>

          <section id="reviews">
            <h2 className="text-xl font-semibold text-foreground mb-3">Reviews</h2>
            <p className="mb-3">
              Anyone can review a company on Tabarnam — <strong className="text-foreground">no account
              required</strong>. Your review helps other visitors and feeds into the company's reputation and
              quality scores.
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mb-3">
              <li><strong className="text-foreground">Where to review</strong> — Click the <em>Review</em> button in the QQ column on any company row.</li>
              <li><strong className="text-foreground">What to fill in</strong> — Only the review text is required (10 characters or more). Subject, name, email, and photos are all optional.</li>
              <li><strong className="text-foreground">What's public, what's private</strong> — Your name (if you give one) appears with your review. Your email is <strong className="text-foreground">private by default</strong> — it's only shown to other users if you check the box, and Tabarnam uses it to email you the review's status.</li>
              <li><strong className="text-foreground">How you're identified</strong> — By default a reviewer shows as <em>"Tabarnam Transparency Advocate."</em> Change it to something more specific like <em>customer</em>, <em>employee</em>, or <em>founder</em>.</li>
              <li><strong className="text-foreground">Photos</strong> — Add up to 3 photos to your review.</li>
              <li><strong className="text-foreground">Publishing</strong> — Reviews are held for a quick moderation pass before they go public. You'll see a confirmation right after you submit; if you left an email, a copy comes to your inbox and we email you again once it's approved.</li>
            </ul>
            <p className="mb-3">
              Approved reviews appear in the <em>Features &amp; Reviews</em> panel inside the expanded company
              profile, alongside external-source reviews.
            </p>
            <p>
              <strong className="text-foreground">Why no star rating?</strong> The reputation and quality parts of
              the QQ score are derived from what people actually <em>say</em> about a company. A star rating would
              mislead reviewers into thinking their number sets the score — the words are what move it.
            </p>
          </section>

          <section id="bookmarks">
            <h2 className="text-xl font-semibold text-foreground mb-3">Bookmarks</h2>
            <p className="mb-3">
              Save companies to come back to later. Bookmarks are stored on <strong className="text-foreground">your
              device only</strong> — there's no account, and we never see what you've saved.
            </p>
            <p className="mb-3">
              Prefer to see it in motion? Click <em>Take the tour</em> at the top of this page for a quick walkthrough that
              ends in the bookmarks panel.
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mb-3">
              <li><strong className="text-foreground">Save a company</strong> — Click the bookmark icon on any result row. It turns blue when saved.</li>
              <li><strong className="text-foreground">Open your bookmarks</strong> — Click the bookmark icon at the top of the page; a drawer slides in with your saved companies.</li>
              <li><strong className="text-foreground">Organize into lists</strong> — Click an already-saved bookmark to assign it to multiple lists (e.g. <em>Coffee brands</em>, <em>Holiday gifts</em>), or create a new list on the fly. Switch to the folder view for an Instagram-style grid with cover images you can set per folder.</li>
              <li><strong className="text-foreground">Rearrange</strong> — Drag companies within a list, drag lists to reorder them, or sort A→Z from a list's menu.</li>
            </ul>
            <p className="mb-3">
              <strong className="text-foreground">Sharing, transferring, and backing up.</strong> Because your
              bookmarks live only on your device, sharing is also how you move them around:
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mb-3">
              <li><strong className="text-foreground">Send to another device</strong> — From a list's menu, choose <em>Share</em>. Email or message yourself the link, then open it on the other device to import the list.</li>
              <li><strong className="text-foreground">Back up before clearing browser data</strong> — Share the list to yourself first. When you open the link later, your bookmarks come back.</li>
              <li><strong className="text-foreground">Send to a friend</strong> — Same flow. Anyone with the link can import the list into their own Tabarnam bookmarks.</li>
            </ul>
            <p>
              We do it this way because your data is yours. With no server-side bookmark history there is nothing for
              us to lose, leak, or hand over. The trade-off: you decide what gets transferred or backed up.
            </p>
          </section>

          <section id="share">
            <h2 className="text-xl font-semibold text-foreground mb-3">Sharing</h2>
            <p className="mb-3">
              Use the share button to send a link to a search results page, a single company profile, or a bookmark
              list. The share dialog includes:
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
