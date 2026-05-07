import { useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { useLocation } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

export default function PrivacyPage() {
  const updatedAt = 'April 15, 2026';
  const contactEmail = 'duh@tabarnam.com';
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) {
      // Plain /privacy arrival — start at top. React Router doesn't reset scroll on SPA nav.
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
        <title>Privacy Policy – Tabarnam</title>
        <meta
          name="description"
          content="Privacy Policy for Tabarnam, including what information is collected, how it is used, and how to contact us."
        />
      </Helmet>

      <main className="max-w-3xl mx-auto px-4 py-16">
        <div className="flex items-start gap-4 mb-8">
          <div className="rounded-2xl border border-border bg-card p-3">
            <ShieldCheck size={32} className="text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Privacy Policy</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Last updated: {updatedAt}
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              This policy applies to Tabarnam websites, web apps, and store-distributed apps.
            </p>
          </div>
        </div>

        <div className="space-y-8 text-muted-foreground leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Overview</h2>
            <p>
              Tabarnam helps people research brands, products, company locations, manufacturing locations,
              headquarters locations, and sourcing context. This Privacy Policy explains what information may be
              processed when you use Tabarnam, how we use it, and how to contact us with privacy questions.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Information We Collect</h2>
            <p>
              Tabarnam may process the information needed to operate the service, including search terms, filters,
              location fields you enter, app or website usage activity, browser or device information, log data,
              and approximate location information derived from your IP address when used to provide location-aware
              results. If you contact us, we may receive your name, email address, phone number, and the contents
              of your message.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Information You Provide</h2>
            <p>
              You may choose to provide product, brand, company, country, state, city, postal code, or address
              information while searching. If account, administrative, or support features are used, we may process
              the information needed to provide those features.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">How We Use Information</h2>
            <p>
              We use information to provide search results, rank and improve results, operate the website and apps,
              remember basic preferences, troubleshoot errors, improve reliability, prevent misuse, maintain security,
              and respond to support requests.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">What We Do Not Do</h2>
            <p>
              We do not sell personal information. We do not use sensitive personal information for targeted
              advertising. We do not require users to create an account to use the basic search experience.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Cookies and Similar Technologies</h2>
            <p>
              We may use cookies, local storage, or similar technologies to keep the service working, remember
              basic preferences such as theme settings, support sign-in or administrative sessions where applicable,
              improve performance, and protect the service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Third-Party Services</h2>
            <p>
              Tabarnam may rely on hosting, analytics, diagnostics, authentication, app store, cloud infrastructure,
              search, mapping, or API providers to operate the service. These providers may process limited
              information on our behalf according to their own terms and privacy practices.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Data Retention</h2>
            <p>
              We retain information only as long as reasonably needed to provide the service, maintain security,
              debug issues, respond to requests, comply with legal obligations, and preserve operational records.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Your Choices</h2>
            <p>
              You can choose not to provide optional information, clear your browser or app storage, disable certain
              browser permissions, or contact us to ask about privacy-related choices available for your interaction
              with Tabarnam.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Children</h2>
            <p>
              Tabarnam is not directed to children under 13, and we do not knowingly collect personal information
              from children under 13. If you believe a child has provided personal information, contact us so we can
              review and remove it where appropriate.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. When we make changes, we will update the
              "Last updated" date above.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">Contact</h2>
            <p>
              If you have questions about this Privacy Policy, contact us at{' '}
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
