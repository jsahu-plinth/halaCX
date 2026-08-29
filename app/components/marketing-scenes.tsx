"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Phone, Waveform } from "@phosphor-icons/react";

const contexts = [
  { key: "receptionist", label: "Receptionist", line: "Ask about opening hours, services or leave a message." },
  { key: "appointment", label: "Appointment booking", line: "Choose a time and hear the agent complete a booking." },
  { key: "lead", label: "Lead qualification", line: "Act as a new lead and let the agent qualify your request." },
  { key: "support", label: "Customer support", line: "Describe an order or service issue and ask for help." },
];

const voiceLevels = Array.from({ length: 120 }, (_, index) => {
  const phrases = [[0, 18, .72], [22, 43, .96], [49, 64, .58], [70, 94, .88], [100, 119, .68]];
  const phrase = phrases.find(([start, end]) => index >= start && index <= end);
  if (!phrase) return 4;
  const [start, end, intensity] = phrase;
  const position = (index - start) / (end - start);
  const envelope = Math.pow(Math.sin(Math.PI * position), .42);
  const voiceTexture = .24 + .76 * Math.abs(Math.sin(index * 1.91) * .62 + Math.sin(index * .47) * .38);
  return Math.max(7, Math.round(100 * intensity * envelope * voiceTexture));
});

export default function MarketingScenes() {
  const [activeStep, setActiveStep] = useState(0);
  const [context, setContext] = useState(contexts[0]);
  const [phone, setPhone] = useState("+971");
  const [callState, setCallState] = useState<"idle"|"loading"|"success"|"error">("idle");
  const [message, setMessage] = useState("");
  const actionRef = useRef<HTMLElement | null>(null);
  const stepRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};

    async function buildScrollStory() {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      if (cancelled || !actionRef.current) return;

      gsap.registerPlugin(ScrollTrigger);
      const section = actionRef.current;
      const cards = stepRefs.current.filter((card): card is HTMLDivElement => Boolean(card));
      const context = gsap.context(() => {
        gsap.set(cards.slice(1), { yPercent: 108 });
        const timeline = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: section,
            start: "top top",
            end: "+=220%",
            scrub: 0.8,
            pin: true,
            anticipatePin: 1,
            invalidateOnRefresh: true,
            onUpdate: (self) => setActiveStep(Math.min(2, Math.round(self.progress * 2))),
          },
        });
        timeline.to(cards[1], { yPercent: 0, duration: 1 }, 0.15);
        timeline.to(cards[2], { yPercent: 0, duration: 1 }, 1.15);
      }, section);
      cleanup = () => context.revert();
    }

    buildScrollStory();
    return () => { cancelled = true; cleanup(); };
  }, []);

  async function requestCall(event: React.FormEvent) {
    event.preventDefault(); setCallState("loading"); setMessage("");
    try {
      const response = await fetch("/api/calls", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ phone, context: context.key }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The call could not be started.");
      setCallState("success"); setMessage(result.demo ? "Preview started. Connect voice credentials for a real call." : "Call started. Pick up when your phone rings.");
    } catch (error) { setCallState("error"); setMessage(error instanceof Error ? error.message : "The call could not be started."); }
  }

  return <>
    <section className="language-cinema" aria-label="Multilingual conversations">
      <div className="language-heading"><p>ONE CONVERSATION</p><h2>Any language.</h2></div>
      <div className="language-track track-one"><span>مرحباً</span><span>Hello</span><span>नमस्ते</span><span>Bonjour</span></div>
      <div className="cinema-wave" aria-label="Live voice conversation waveform">
        <div className="wave-meta"><span><b/> LIVE CONVERSATION</span><time>00:18</time></div>
        <div className="wave-bars">{voiceLevels.map((level,i)=><i key={i} style={{height:`${level}%`, animationDelay:`-${(i % 17) * 47}ms`}}/>)}</div>
        <div className="wave-playhead" aria-hidden="true"/>
        <div className="wave-speakers"><span>Caller · Arabic</span><span>HalaCX · English</span></div>
      </div>
      <div className="language-track track-two"><span>كيف يمكنني مساعدتك؟</span><span>How can I help?</span><span>मैं कैसे मदद करूँ?</span></div>
      <p className="language-note">Switch languages mid-sentence. Keep the same context, tone and outcome.</p>
    </section>

    <section ref={actionRef} className="action-story" id="platform">
      <div className="action-sticky"><p>FROM CONVERSATION TO COMPLETION</p><h2>It doesn’t just answer.<br/><em>It acts.</em></h2><span>HalaCX moves the work forward while the caller is still on the line.</span><div className="action-progress"><i style={{transform:`scaleX(${(activeStep+1)/3})`}}/></div></div>
      <div className="action-steps">
        <div ref={el=>{stepRefs.current[0]=el}} data-step="0" className={activeStep===0?"active":""}><header><span>01 / 03</span><i><b/> CALL CONNECTED</i></header><main><p>CALLER ASKS</p><h3>“I’d like to book an appointment.”</h3><div className="step-signal"><Waveform/><span><strong>Appointment request</strong><small>Intent detected · 98% confidence</small></span></div></main><footer><span>EN</span><small>Natural language understood</small></footer></div>
        <div ref={el=>{stepRefs.current[1]=el}} data-step="1" className={activeStep===1?"active":""}><header><span>02 / 03</span><i><b/> SYSTEM CONNECTED</i></header><main><p>HALACX CHECKS</p><h3>Calendar availability, in real time.</h3><div className="calendar-strip"><span><small>10:30</small>Unavailable</span><span className="selected"><small>15:30</small>Available</span><span><small>17:00</small>Available</span></div></main><footer><span>0.6s</span><small>Google Calendar responded</small></footer></div>
        <div ref={el=>{stepRefs.current[2]=el}} data-step="2" className={activeStep===2?"active":""}><header><span>03 / 03</span><i><b/> ACTION COMPLETE</i></header><main><p>HALACX CONFIRMS</p><h3>“You’re all set. See you tomorrow.”</h3><div className="completion-list"><span><Check/> Booking saved</span><span><Check/> Confirmation sent</span><span><Check/> CRM updated</span></div></main><footer><span><Check/></span><small>Completed while the caller was on the line</small></footer></div>
      </div>
    </section>

    <section className="operations-cinema" id="solutions">
      <div className="operations-copy"><p>EVERY CALL, MOVING</p><h2>A call center that moves at the speed of the call.</h2></div>
      <div className="operation-stage">
        <header><span><i/> CALL IN PROGRESS</span><time>02:18</time></header>
        <div className="live-call-layout">
          <div className="live-call-thread">
            <div className="caller-identity"><span>FA</span><p><strong>Fatima A.</strong><small>Arabic · +971 50 ••• 6805</small></p><em>Billing support</em></div>
            <div className="call-turn caller-turn"><time>02:11</time><div><small>FATIMA</small><p>تم تحصيل المبلغ مرتين من طلبي.</p><span>I was charged twice for my order.</span></div></div>
            <div className="call-turn agent-turn"><time>02:14</time><div><small>HALACX</small><p>I found order #98217. I’m checking the two payments now.</p></div></div>
            <div className="call-turn agent-turn active-turn"><time>02:18</time><div><small>HALACX · SPEAKING</small><p>The duplicate is confirmed. I can prepare the refund while we’re on this call.</p></div></div>
          </div>
          <aside className="action-ledger"><header><span>ACTION LEDGER</span><small>LIVE</small></header><ol><li className="complete"><time>02:13</time><i><Check/></i><p><strong>Customer verified</strong><small>Matched by caller ID</small></p></li><li className="complete"><time>02:15</time><i><Check/></i><p><strong>Order #98217 opened</strong><small>Commerce API · 0.4s</small></p></li><li className="complete"><time>02:17</time><i><Check/></i><p><strong>Duplicate payment found</strong><small>Payment gateway · AED 184</small></p></li><li className="current"><time>NOW</time><i>→</i><p><strong>Refund being prepared</strong><small>Awaiting caller confirmation</small></p></li></ol></aside>
        </div>
        <footer><span><Check/> Caller identity verified</span><span><Check/> CRM updated</span><span className="processing"><i/> Refund workflow running</span></footer>
      </div>
      <div className="transcript-film"><span>00:15 · CUSTOMER</span><p>I was charged twice and received one confirmation.</p><span>00:18 · HALACX</span><p>I can help with that right away.</p><span>00:24 · ACTION</span><p>Order #98217 retrieved.</p></div>
    </section>

    <section className="live-demo-lab" id="live-demo">
      <div className="demo-form-side"><p>LIVE DEMO</p><h2>Don’t take our word for it.<br/>Take the call.</h2><span>Choose a conversation and enter the number you want us to call.</span><div className="context-tabs" role="tablist">{contexts.map(item=><button key={item.key} className={context.key===item.key?"active":""} onClick={()=>setContext(item)} role="tab" aria-selected={context.key===item.key}>{item.label}</button>)}</div><p className="context-line">{context.line}</p><form onSubmit={requestCall}><label htmlFor="demo-phone">YOUR MOBILE NUMBER</label><div><input id="demo-phone" value={phone} onChange={event=>setPhone(event.target.value)} inputMode="tel" aria-label="Mobile number in international format"/><button disabled={callState==="loading"}><Phone weight="fill"/>{callState==="loading"?"Calling…":"Call me"}</button></div>{message&&<small className={callState}>{message}</small>}</form></div>
      <div className="demo-storyboard"><p>WHAT HAPPENS NEXT</p><ol><li><span>1</span><div><strong>You request a demo</strong><small>Pick a context and enter your number.</small></div></li><li><span>2</span><div><strong>We call you in seconds</strong><small>No app, headset or setup required.</small></div></li><li><span>3</span><div><strong>You talk to HalaCX</strong><small>A real voice agent follows the selected scenario.</small></div></li><li><span>4</span><div><strong>You see the outcome</strong><small>The transcript and call details land in your workspace.</small></div></li></ol></div>
    </section>

    <section className="systems-finale" id="security"><div className="finale-copy"><p>BUILT AROUND YOUR BUSINESS</p><h2>Your number.<br/>Your systems.<br/>Your rules.</h2><span>Connect the tools and people you already rely on. Keep control of every handoff, action and record.</span><Link href="/login?mode=signup">Build your contact center <ArrowRight/></Link></div><div className="systems-map"><div className="system-source">Existing<br/>phone number</div><i className="line line-in"/><div className="system-core"><Waveform/>HalaCX</div><i className="line line-out"/><div className="system-targets"><span>CRM</span><span>Calendar</span><span>Human team</span></div></div></section>
  </>;
}
