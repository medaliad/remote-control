import { useEffect, useState } from "react";
import { Home } from "./pages/Home";
import { HostPage } from "./pages/Host";
import { ClientPage } from "./pages/Client";
import { MonitorPlay, Eye, Zap } from "lucide-react";

/**
 * Tiny hash router. Three routes:
 *   #/          → Home
 *   #/host      → Host flow
 *   #/client    → Client flow  (optional ?code=ABC123 prefills the code)
 *
 * Hash routing avoids needing any server-side route config — good fit for a
 * static-asset SPA behind a single Node server. React Router would work too,
 * but is overkill for 3 routes.
 */

type Route =
  | { kind: "home" }
  | { kind: "host" }
  | { kind: "client"; prefillCode: string | null };

function parseRoute(): Route {
  const h = window.location.hash || "#/";
  const [path, query = ""] = h.slice(1).split("?");
  const qs = new URLSearchParams(query);
  if (path === "/host")          return { kind: "host" };
  if (path === "/client")        return { kind: "client", prefillCode: qs.get("code") };
  return { kind: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (to: "home" | "host" | "client") => {
    window.location.hash = to === "home" ? "#/" : `#/${to}`;
  };

  return (
    <div className="relative min-h-screen flex flex-col overflow-x-hidden">
      {/* Decorative animated glow blobs — pure visual, no interactivity */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden -z-10">
        <div className="absolute top-[-10%] left-[5%] w-[40rem] h-[40rem] rounded-full bg-accent/20 blur-3xl animate-blob-float" />
        <div className="absolute bottom-[-15%] right-[-5%] w-[35rem] h-[35rem] rounded-full bg-accent-hi/15 blur-3xl animate-blob-float [animation-delay:-4s]" />
      </div>

      <nav className="sticky top-0 z-20 glass-strong border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto flex items-center gap-3 px-5 sm:px-8 py-3.5">
          <a
            className="group inline-flex items-center gap-2.5 font-semibold tracking-tight transition-transform hover:-translate-y-[1px]"
            href="#/"
          >
            <span className="relative w-9 h-9 rounded-xl grid place-items-center text-white shadow-glow overflow-hidden">
              <span className="absolute inset-0 bg-gradient-to-br from-accent via-accent-hi to-[#a78bfa] bg-[length:200%_200%] animate-gradient-shift" />
              <Zap className="relative w-4 h-4 fill-white" strokeWidth={2.5} />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-[15px] font-bold">Remote Access</span>
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted">
                Peer · Secure · Instant
              </span>
            </span>
          </a>

          <div className="flex-1" />

          <a
            className={[
              "relative inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200",
              route.kind === "host"
                ? "text-white bg-accent/15 shadow-[inset_0_0_0_1px_rgba(124,106,255,0.4)]"
                : "text-muted hover:text-text hover:bg-white/[0.04]",
            ].join(" ")}
            href="#/host"
            onClick={(e) => { e.preventDefault(); navigate("host"); }}
          >
            <MonitorPlay className="w-4 h-4" strokeWidth={2.2} />
            <span>Host</span>
          </a>
          <a
            className={[
              "relative inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200",
              route.kind === "client"
                ? "text-white bg-accent/15 shadow-[inset_0_0_0_1px_rgba(124,106,255,0.4)]"
                : "text-muted hover:text-text hover:bg-white/[0.04]",
            ].join(" ")}
            href="#/client"
            onClick={(e) => { e.preventDefault(); navigate("client"); }}
          >
            <Eye className="w-4 h-4" strokeWidth={2.2} />
            <span>Join</span>
          </a>
        </div>
      </nav>

      <main className="flex-1 flex items-start justify-center px-4 sm:px-6 py-10 sm:py-16">
        <div key={route.kind} className="w-full flex justify-center animate-fade-in">
          {route.kind === "home"   && <Home navigate={navigate} />}
          {route.kind === "host"   && <HostPage />}
          {route.kind === "client" && <ClientPage prefillCode={route.prefillCode} />}
        </div>
      </main>
    </div>
  );
}
