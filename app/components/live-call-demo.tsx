"use client";

import { useEffect, useRef, useState } from "react";
import { Check, PhoneCall, Waveform } from "@phosphor-icons/react";

const stages = [
  { phase: 0, wait: 1800 },
  { phase: 1, wait: 2400 },
  { phase: 2, wait: 3200 },
  { phase: 3, wait: 1200 },
  { phase: 4, wait: 3800 },
  { phase: 5, wait: 2600 },
];

export default function LiveCallDemo() {
  const root = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.35 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const reducedTimer = window.setTimeout(() => setPhase(5), 0);
      return () => window.clearTimeout(reducedTimer);
    }
    const current = stages.find((stage) => stage.phase === phase) || stages[0];
    const timer = window.setTimeout(() => {
      const next = (phase + 1) % stages.length;
      if (next === 0) setSeconds(0);
      setPhase(next);
    }, current.wait);
    return () => window.clearTimeout(timer);
  }, [phase, visible]);

  useEffect(() => {
    if (!visible || phase === 0) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [visible, phase]);

  const elapsed = `00:${String(seconds).padStart(2, "0")}`;
  const activeVoice = phase === 2 ? "caller" : phase === 4 ? "agent" : "none";

  return <div className="agent-demo" ref={root} data-phase={phase}>
    <div className="demo-tabs"><button className="active">Voice</button><button>Chat</button></div>
    <div className="demo-card">
      <div className="demo-call-status"><span className="demo-avatar"><Waveform weight="bold" /></span><div><strong>{phase === 0 ? "Incoming call" : phase === 1 ? "Connected" : phase === 3 ? "Understanding…" : "Call in progress"}</strong><small>{phase === 0 ? "+971 50 218 4431" : elapsed}</small></div><i className={phase > 0 ? "connected" : ""}/></div>
      <div className={`voice-activity ${activeVoice}`} aria-hidden="true">{Array.from({ length: 26 }).map((_, index) => <i key={index} style={{ animationDelay: `${index * 38}ms` }}/>)}</div>
      <div className="demo-conversation">
        <div className="demo-message caller-message"><small>Caller · Arabic</small><p>هل يمكنني حجز موعد غداً؟</p></div>
        <div className="detection-line"><span/><p>Arabic detected · translating live</p></div>
        <div className="demo-message agent-message"><small>HalaCX agent</small><p>بالتأكيد. لدي موعد متاح غداً الساعة 3:30 مساءً.</p></div>
        <div className="demo-action"><Check weight="bold"/><p><small>ACTION COMPLETED</small><strong>Appointment reserved · 3:30 PM</strong></p></div>
      </div>
      <button className="demo-call"><PhoneCall weight="fill"/><span>{phase === 0 ? "Answer" : "End call"}</span></button>
    </div>
  </div>;
}
