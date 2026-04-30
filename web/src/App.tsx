import { useEffect, useState } from "react";
import { Home } from "./pages/Home";
import { HostPage } from "./pages/Host";
import { ClientPage } from "./pages/Client";
import { MonitorPlay, Eye, Zap } from "lucide-react";
type Route = {
  kind: "home";
} | {
  kind: "host";
  autoPairToken: string | null;
} | {
  kind: "client";
  prefillCode: string | null;
  autoPairToken: string | null;
};
interface ParsedLocation {
  route: Route;
  embed: boolean;
}
function parseLocation(): ParsedLocation {
  const h = window.location.hash || "#/";
  const [path, query = ""] = h.slice(1).split("?");
  const qs = new URLSearchParams(query);
  const embed = qs.get("embed") === "1" || qs.get("embed") === "true";
  const autoPairToken = qs.get("token") || null;
  let route: Route;
  if (path === "/host") route = {
    kind: "host",
    autoPairToken
  };else if (path === "/client") route = {
    kind: "client",
    prefillCode: qs.get("code"),
    autoPairToken
  };else route = {
    kind: "home"
  };
  return {
    route,
    embed
  };
}
export function App() {
  const [{
    route,
    embed
  }, setLocation] = useState<ParsedLocation>(() => parseLocation());
  useEffect(() => {
    const onHash = () => setLocation(parseLocation());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (embed) {
      document.documentElement.classList.add("embed-mode");
      document.body.classList.add("embed-mode");
    } else {
      document.documentElement.classList.remove("embed-mode");
      document.body.classList.remove("embed-mode");
    }
    return () => {
      document.documentElement.classList.remove("embed-mode");
      document.body.classList.remove("embed-mode");
    };
  }, [embed]);
  const navigate = (to: "home" | "host" | "client") => {
    const suffix = embed ? "?embed=1" : "";
    window.location.hash = to === "home" ? `#/${suffix}` : `#/${to}${suffix}`;
  };
  if (embed) {
    return <div className="relative min-h-screen w-full flex flex-col bg-canvas overflow-hidden">
        <main className="flex-1 flex w-full">
          <div key={route.kind} className="w-full flex-1 flex animate-fade-in">
            {route.kind === "home" && <Home navigate={navigate} embed />}
            {route.kind === "host" && <HostPage embed autoPairToken={route.autoPairToken} />}
            {route.kind === "client" && <ClientPage prefillCode={route.prefillCode} autoPairToken={route.autoPairToken} embed />}
          </div>
        </main>
      </div>;
  }
  return <div className="relative min-h-screen flex flex-col overflow-x-hidden">
      <nav className="sticky top-0 z-20 bg-white/95 backdrop-blur-xl border-b border-line">
        <div className="max-w-7xl mx-auto flex items-center gap-2 sm:gap-3 px-3 sm:px-5 md:px-8 py-3 sm:py-3.5">
          <a className="group inline-flex items-center gap-2 sm:gap-2.5 font-semibold tracking-tight transition-transform hover:-translate-y-[1px] min-w-0 text-text" href="#/">
            <span className="relative w-9 h-9 rounded-xl grid place-items-center text-white shadow-glow overflow-hidden shrink-0 bg-gradient-to-br from-primary to-accent-hi">
              <Zap className="relative w-4 h-4 fill-white" strokeWidth={2.5} />
            </span>
            <span className="flex flex-col leading-tight min-w-0">
              <span className="text-[14px] sm:text-[15px] font-bold truncate text-text900">Remote Access</span>
              <span className="hidden sm:inline text-[10px] font-medium uppercase tracking-[0.18em] text-muted">
                Peer &middot; Secure &middot; Instant
              </span>
            </span>
          </a>

          <div className="flex-1" />

          <a className={["relative inline-flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200", route.kind === "host" ? "text-primary bg-primary-soft border border-primary/15" : "text-muted hover:text-text900 hover:bg-canvas"].join(" ")} href="#/host" onClick={e => {
          e.preventDefault();
          navigate("host");
        }}>
            <MonitorPlay className="w-4 h-4" strokeWidth={2.2} />
            <span className="hidden xs:inline">Host</span>
          </a>
          <a className={["relative inline-flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200", route.kind === "client" ? "text-primary bg-primary-soft border border-primary/15" : "text-muted hover:text-text900 hover:bg-canvas"].join(" ")} href="#/client" onClick={e => {
          e.preventDefault();
          navigate("client");
        }}>
            <Eye className="w-4 h-4" strokeWidth={2.2} />
            <span className="hidden xs:inline">Join</span>
          </a>
        </div>
      </nav>

      <main className="flex-1 flex items-start justify-center px-3 sm:px-6 py-6 sm:py-10 md:py-16">
        <div key={route.kind} className="w-full flex justify-center animate-fade-in">
          {route.kind === "home" && <Home navigate={navigate} />}
          {route.kind === "host" && <HostPage autoPairToken={route.autoPairToken} />}
          {route.kind === "client" && <ClientPage prefillCode={route.prefillCode} autoPairToken={route.autoPairToken} />}
        </div>
      </main>
    </div>;
}
