import { Helmet } from 'react-helmet-async';
import { Accessibility } from 'lucide-react';

export default function AccessibilityPage() {
  const contactEmail = 'duh@tabarnam.com';

  return (
    <>
      <Helmet>
        <title>Accessibility – Tabarnam</title>
        <meta
          name="description"
          content="Tabarnam's accessibility statement — how the site supports screen readers, keyboard navigation, color contrast, motion preferences, and forgiving search."
        />
      </Helmet>

      {/* Plain div (not <main>) because App.jsx's Layout already wraps every
          route in <main id="main-content"> as the skip-link target. */}
      <div className="max-w-3xl mx-auto px-4 py-16">
        <div className="flex items-start gap-4 mb-8">
          <div className="rounded-2xl border border-border bg-card p-3">
            <Accessibility size={32} className="text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Accessibility</h1>
            <p className="text-sm text-muted-foreground mt-2 italic">
              Built to work with the tools you already use.
            </p>
          </div>
        </div>

        <nav aria-label="On this page" className="mb-10 rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            On this page
          </p>
          <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <li><a href="#approach" className="text-primary underline underline-offset-4">Our approach</a></li>
            <li><a href="#screen-readers" className="text-primary underline underline-offset-4">Screen readers &amp; read-aloud</a></li>
            <li><a href="#keyboard" className="text-primary underline underline-offset-4">Keyboard navigation</a></li>
            <li><a href="#vision" className="text-primary underline underline-offset-4">Vision</a></li>
            <li><a href="#motion" className="text-primary underline underline-offset-4">Motion sensitivity</a></li>
            <li><a href="#forgiving-search" className="text-primary underline underline-offset-4">Forgiving search</a></li>
            <li><a href="#limitations" className="text-primary underline underline-offset-4">Known limitations &amp; feedback</a></li>
          </ul>
        </nav>

        <div className="space-y-10 text-muted-foreground leading-relaxed">
          <section id="approach">
            <h2 className="text-xl font-semibold text-foreground mb-3">Our approach</h2>
            <p>
              Tabarnam doesn't use an accessibility overlay or widget. The site is built to work with the
              settings, browsers, and assistive technology you <strong className="text-foreground">already
              have</strong> — nothing to install, nothing to enable in a separate menu.
            </p>
          </section>

          <section id="screen-readers">
            <h2 className="text-xl font-semibold text-foreground mb-3">Screen readers &amp; read-aloud</h2>
            <p className="mb-3">
              Pages use semantic landmarks (<em>main</em>, <em>nav</em>, headings, dialogs) so screen readers
              can announce structure and jump between regions.
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mb-3">
              <li>QQ ratings are announced as <em>"3.6 out of 5"</em> rather than a bare number.</li>
              <li>Form fields have visible and programmatic labels.</li>
              <li>Images have alt text; decorative icons are marked as such so they aren't read aloud.</li>
              <li>The page language is declared (<em>lang="en"</em>).</li>
            </ul>
            <p>
              Tested with <strong className="text-foreground">VoiceOver</strong> (macOS / iOS),
              <strong className="text-foreground"> NVDA</strong> and <strong className="text-foreground">JAWS
              </strong> (Windows), <strong className="text-foreground"> TalkBack</strong> (Android), and
              browser read-aloud extensions.
            </p>
          </section>

          <section id="keyboard">
            <h2 className="text-xl font-semibold text-foreground mb-3">Keyboard navigation</h2>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>A <strong className="text-foreground">Skip to main content</strong> link is the first Tab stop on every page, jumping past the header and filter chrome.</li>
              <li>Search, filters, sort, cards, and dialogs are all fully keyboard-operable.</li>
              <li><em>Escape</em> closes dialogs and popovers.</li>
              <li>Focus rings are visible on every interactive element.</li>
            </ul>
          </section>

          <section id="vision">
            <h2 className="text-xl font-semibold text-foreground mb-3">Vision</h2>
            <ul className="list-disc pl-6 space-y-1.5">
              <li><strong className="text-foreground">Color contrast</strong> — designed to meet WCAG 2.1 AA in both light and dark themes; automated <em>axe-core</em> scans of the home and results pages pass in both themes.</li>
              <li><strong className="text-foreground">Theme toggle</strong> — switch light/dark manually, or leave it on the system-preference setting.</li>
              <li><strong className="text-foreground">Browser zoom &amp; OS text size</strong> — work normally. Tabarnam uses relative (<em>rem</em>) sizing and doesn't hijack your zoom or text-size preferences.</li>
            </ul>
          </section>

          <section id="motion">
            <h2 className="text-xl font-semibold text-foreground mb-3">Motion sensitivity</h2>
            <p>
              If your OS or browser has <strong className="text-foreground">"reduce motion"</strong> turned on,
              Tabarnam honors it site-wide — CSS transitions and framer-motion animations are minimized or
              disabled so nothing swoops, spins, or fades unnecessarily.
            </p>
          </section>

          <section id="forgiving-search">
            <h2 className="text-xl font-semibold text-foreground mb-3">Forgiving search</h2>
            <p>
              Precision shouldn't be a barrier. Search handles typo correction, synonyms, singular/plural
              matching, and compound-word variations so you don't have to spell every query exactly.
            </p>
          </section>

          <section id="limitations">
            <h2 className="text-xl font-semibold text-foreground mb-3">Known limitations &amp; feedback</h2>
            <p className="mb-3">
              We want to be straight with you: automated testing catches the mechanically-detectable parts of
              WCAG, but it can't catch everything. Full manual screen-reader walkthroughs of complex flows —
              specifically the review dialog and the bookmarks drawer — are still on our to-do list.
            </p>
            <p>
              If you hit an accessibility problem or have a suggestion, please email us at{' '}
              <a className="text-primary underline underline-offset-4" href={`mailto:${contactEmail}`}>
                {contactEmail}
              </a>
              . We'll address it.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
