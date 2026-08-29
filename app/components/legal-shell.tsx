import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Waveform } from "@phosphor-icons/react/dist/ssr";

export type LegalSection = {
  id: string;
  title: string;
  content: React.ReactNode;
};

type LegalShellProps = {
  label: string;
  title: string;
  summary: string;
  effectiveDate: string;
  sections: LegalSection[];
};

export default function LegalShell({ label, title, summary, effectiveDate, sections }: LegalShellProps) {
  return (
    <main id="content" className="legal-page">
      <nav className="legal-nav" aria-label="Legal page navigation">
        <Link className="wordmark" href="/"><span className="wordmark-mark"><Waveform weight="bold" /></span><span>hala<strong>CX</strong></span></Link>
        <Link href="/"><ArrowLeft /> Back to HalaCX</Link>
      </nav>

      <header className="legal-hero">
        <div><p>{label}</p><h1>{title}</h1></div>
        <div><p>{summary}</p><span>Effective {effectiveDate}</span></div>
      </header>

      <div className="legal-layout">
        <aside aria-label="On this page">
          <p>On this page</p>
          <nav>{sections.map((section, index) => <a key={section.id} href={`#${section.id}`}><span>{String(index + 1).padStart(2, "0")}</span>{section.title}</a>)}</nav>
          <div><span>Questions about this document?</span><a href="mailto:legal@polinth.com">legal@polinth.com <ArrowUpRight /></a></div>
        </aside>

        <article className="legal-document">
          {sections.map((section, index) => <section id={section.id} key={section.id}><span>{String(index + 1).padStart(2, "0")}</span><div><h2>{section.title}</h2>{section.content}</div></section>)}
        </article>
      </div>

      <footer className="legal-footer"><Link className="wordmark wordmark-light" href="/"><span className="wordmark-mark"><Waveform weight="bold" /></span><span>hala<strong>CX</strong></span></Link><p>Multilingual AI voice agents<br/>for modern contact centers.</p><div><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="mailto:legal@polinth.com">Legal contact</a></div><small>© 2026 HalaCX. Operated by Polinth Software Trading L.L.C.</small></footer>
    </main>
  );
}
