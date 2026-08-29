import Link from "next/link";
import { ArrowRight, Waveform } from "@phosphor-icons/react/dist/ssr";
import LiveCallDemo from "./components/live-call-demo";
import MarketingScenes from "./components/marketing-scenes";

export default function Home() {
  return (
    <main id="content" className="marketing">
      <nav className="site-nav" aria-label="Main navigation">
        <Link className="wordmark" href="/"><span className="wordmark-mark"><Waveform weight="bold" /></span><span>hala<strong>CX</strong></span></Link>
        <div className="nav-links"><a href="#platform">Platform</a><a href="#solutions">Solutions</a><a href="#live-demo">Live demo</a><a href="#security">Security</a></div>
        <div className="nav-actions"><Link className="text-link" href="/login">Log in</Link><Link className="button button-dark" href="/login?mode=signup">Build your agent <ArrowRight /></Link></div>
      </nav>

      <section className="hero-section">
        <div className="hero-copy">
          <h1>Every customer.<br/>Every language.<br/>Every call.</h1>
          <p className="hero-intro">Deploy multilingual voice agents that answer, resolve and act across your entire contact center.</p>
          <div className="hero-actions"><Link className="button button-dark" href="/login?mode=signup">Create your agent</Link><a className="button button-outline" href="mailto:sales@polinth.com">Talk to sales</a></div>
        </div>
        <div className="hero-product" id="demo">
          <LiveCallDemo />
        </div>
      </section>

      <MarketingScenes />

      <footer><Link className="wordmark wordmark-light" href="/"><span className="wordmark-mark"><Waveform weight="bold" /></span><span>hala<strong>CX</strong></span></Link><p>Multilingual AI voice agents<br/>for modern contact centers.</p><div><Link href="/login">Log in</Link><a href="#platform">Platform</a><a href="#security">Security</a></div><small>© 2026 HalaCX · <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link></small></footer>
    </main>
  );
}
