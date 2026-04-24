import { MonitorPlay, Eye, Shield, ArrowRight, Sparkles } from "lucide-react";

interface Props {
  navigate: (to: "home" | "host" | "client") => void;
}

/**
 * Landing screen. Two actions — be the host, or join as a client. That's
 * the whole decision, so we make it visually primary and skip the nav bar
 * repetition.
 */
export function Home({ navigate }: Props) {
  return (
    <div className="w-full max-w-5xl animate-slide-up">
      {/* Hero card */}
      <div className="relative overflow-hidden rounded-3xl glass-strong shadow-soft-xl p-8 sm:p-12">
        {/* Subtle dot grid */}
        <div className="absolute inset-0 bg-dots opacity-50 pointer-events-none" />
        <div className="absolute -top-24 -right-24 w-80 h-80 rounded-full bg-accent/20 blur-3xl pointer-events-none" />

        <div className="relative">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-accent/30 bg-accent/10 text-accent-hi text-xs font-medium tracking-wide mb-6">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Approval-first screen sharing</span>
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-[1.05] mb-5">
            <span className="text-gradient">Remote Access</span>
            <br />
            <span className="text-text/70 text-2xl sm:text-3xl md:text-4xl font-semibold">
              with a click, not a backdoor.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-muted max-w-2xl leading-relaxed mb-10">
            Share your screen with someone you trust, with an explicit approval
            step on every connection. No auto-accept, no background sharing —
            nothing happens without your click.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5">
            <a
              className="group relative flex flex-col gap-3 p-6 rounded-2xl border border-white/[0.08] bg-surface-2/60 backdrop-blur-sm transition-all duration-300 hover:border-accent/60 hover:bg-surface-2 hover:-translate-y-1 hover:shadow-glow overflow-hidden"
              href="#/host"
              onClick={(e) => { e.preventDefault(); navigate("host"); }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-accent/0 via-accent/0 to-accent/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
              <div className="relative flex items-start justify-between">
                <span className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-accent/25 to-accent/5 border border-accent/30 text-accent-hi group-hover:scale-110 transition-transform duration-300">
                  <MonitorPlay className="w-6 h-6" strokeWidth={2.2} />
                </span>
                <ArrowRight className="w-5 h-5 text-muted group-hover:text-accent-hi group-hover:translate-x-1 transition-all duration-300" />
              </div>
              <span className="relative text-lg font-semibold tracking-tight">
                Share my screen (Host)
              </span>
              <span className="relative text-sm text-muted leading-relaxed">
                Generate a one-time code. A client must enter it and you must
                approve their request before anything starts.
              </span>
            </a>

            <a
              className="group relative flex flex-col gap-3 p-6 rounded-2xl border border-white/[0.08] bg-surface-2/60 backdrop-blur-sm transition-all duration-300 hover:border-accent/60 hover:bg-surface-2 hover:-translate-y-1 hover:shadow-glow overflow-hidden"
              href="#/client"
              onClick={(e) => { e.preventDefault(); navigate("client"); }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-accent/0 via-accent/0 to-accent/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
              <div className="relative flex items-start justify-between">
                <span className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-accent/25 to-accent/5 border border-accent/30 text-accent-hi group-hover:scale-110 transition-transform duration-300">
                  <Eye className="w-6 h-6" strokeWidth={2.2} />
                </span>
                <ArrowRight className="w-5 h-5 text-muted group-hover:text-accent-hi group-hover:translate-x-1 transition-all duration-300" />
              </div>
              <span className="relative text-lg font-semibold tracking-tight">
                View a shared screen (Client)
              </span>
              <span className="relative text-sm text-muted leading-relaxed">
                Enter the code the host gave you. You'll see "waiting for
                approval" until they accept — then the screen appears.
              </span>
            </a>
          </div>

          <div className="mt-8 flex items-start gap-3 p-4 rounded-xl border border-accent/20 bg-accent/[0.06]">
            <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-8 h-8 rounded-lg bg-accent/15 text-accent-hi">
              <Shield className="w-4 h-4" strokeWidth={2.4} />
            </span>
            <p className="text-sm text-[#d9d3ff]/90 leading-relaxed">
              <strong className="font-semibold text-white">Privacy:</strong>{" "}
              screen sharing runs peer-to-peer via WebRTC. The server only
              relays the one-time approval handshake — your screen contents
              never pass through it.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
