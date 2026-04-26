import { useEffect, useState } from "react";
import { Home } from "./pages/Home";
import { HostPage } from "./pages/Host";
import { ClientPage } from "./pages/Client";
import { MonitorPlay, Eye, Zap } from "lucide-react";

/**
 * Tiny hash router. Three routes:
 *   #/          -> Home
 *   #/host      -> Host flow
 *   #/client    -> Client flow  (optional ?code=ABC123 prefills the code)
 *
 * Query params on any route:
 *   ?embed=1       -> strip chrome (nav, padding, decorative blobs) so the
 *                    page can be cleanly placed inside an <iframe> in
 *                    another app. Pages still render their own controls,
 *                    but in a chromeless edge-to-edge layout.
 *
 * Hash routing avoids needing any server-side route config -- good fit for
 * a static-asset SPA behind a single Node server. React Router would work
 * too, but is overkill for 3 routes.
 */

type Route =
  | { kind: "home" }
  | { kind: "host" }
  | { kind: "client"; prefillCode: string | null };

interface ParsedLocation {
  route: Route;
  embed: boolean;
}

function parseLocation(): ParsedLocation {
  const h = window.location.hash || "#/";
  const [path, query = ""] = h.slice(1).split("?");
  const qs = new URLSearchParams(query);
  const embed = qs.get("embed") === "1" || qs.get("embed") === "true";

  let route: Route;
  if (path === "/host")        route = { kind: "host" };
  else if (path === "/client") route = { kind: "client", prefillCode: qs.get("code") };
  else                          route = { kind: "home" };

  return { route, embed };
}

export function App() {
  const [{ route, embed }, setLocation] = useState<ParsedLocation>(() => parseLocation());

  useEffect(() => {
    const onHash = () => setLocation(parseLocation());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Make the page itself "iframe-friendly" when embedded -- drop the body
  // gradient and disable overflow so we don't show scrollbars on top of the
  // session pages that already manage their own viewport.
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
    // Preserve embed flag across navigations so iframe parents don't lose it.
    const suffix = embed ? "?embed=1" : "";
    window.location.hash = to === "home" ? `#/${suffix}` : `#/${to}${suffix}`;
  };

  // Embed mode: chromeless full-viewport layout, no nav, no decorative
  // blobs, no centering paddings. Pages render edge-to-edge inside whatever
  // frame is hosting us. We keep `min-h-screen` so a page that doesn't fill
  // on its own (a small form) still anchors at the top.
  if (embed) {
    return (
      <div className="relative min-h-screen w-full flex flex-col bg-bg overflow-hidden">
        <main className="flex-1 flex w-full">
          <div key={route.kind} className="w-full flex-1 flex animate-fade-in">
            {route.kind === "home"   && <Home navigate={navigate} embed />}
            {route.kind === "host"   && <HostPage embed />}
            {route.kind === "client" && <ClientPage prefillCode={route.prefillCode} embed />}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen flex flex-col overflow-x-hidden">
      {/* Decorative animated glow blobs -- pure visual, no interactivity */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden -z-10">
        <div className="absolute top-[-10%] left-[5%] w-[40rem] h-[40rem] rounded-full bg-accent/20 blur-3xl animate-blob-float" />
        <div className="absolute bottom-[-15%] right-[-5%] w-[35rem] h-[35rem] rounded-full bg-accent-hi/15 blur-3xl animate-blob-float [animation-delay:-4s]" />
      </div>

      <nav className="sticky top-0 z-20 glass-strong border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto flex items-center gap-2 sm:gap-3 px-3 sm:px-5 md:px-8 py-3 sm:py-3.5">
          <a
            className="group inline-flex items-center gap-2 sm:gap-2.5 font-semibold tracking-tight transition-transform hover:-translate-y-[1px] min-w-0"
            href="#/"
          >
            <span className="relative w-9 h-9 rounded-xl grid place-items-center text-white shadow-glow overflow-hidden shrink-0">
              <span className="absolute inset-0 bg-gradient-to-br from-accent via-accent-hi to-[#a78bfa] bg-[length:200%_200%] animate-gradient-shift" />
              <Zap className="relative w-4 h-4 fill-white" strokeWidth={2.5} />
            </span>
            <span className="flex flex-col leading-tight min-w-0">
              <span className="text-[14px] sm:text-[15px] font-bold truncate">Remote Access</span>
              <span className="hidden sm:inline text-[10px] font-medium uppercase tracking-[0.18em] text-muted">
                Peer &middot; Secure &middot; Instant
              </span>
            </span>
          </a>

          <div className="flex-1" />

          <a
            className={[
              "relative inline-flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200",
              route.kind === "host"
                ? "text-white bg-accent/15 shadow-[inset_0_0_0_1px_rgba(124,106,255,0.4)]"
                : "text-muted hover:text-text hover:bg-white/[0.04]",
            ].join(" ")}
            href="#/host"
            onClick={(e) => { e.preventDefault(); navigate("host"); }}
          >
            <MonitorPlay className="w-4 h-4" strokeWidth={2.2} />
            <span className="hidden xs:inline">Host</span>
          </a>
          <a
            className={[
              "relative inline-flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200",
              route.kind === "client"
                ? "text-white bg-accent/15 shadow-[inset_0_0_0_1px_rgba(124,106,255,0.4)]"
                : "text-muted hover:text-text hover:bg-white/[0.04]",
            ].join(" ")}
            href="#/client"
            onClick={(e) => { e.preventDefault(); navigate("client"); }}
          >
            <Eye className="w-4 h-4" strokeWidth={2.2} />
            <span className="hidden xs:inline">Join</span>
          </a>
        </div>
      </nav>

      <main className="flex-1 flex items-start justify-center px-3 sm:px-6 py-6 sm:py-10 md:py-16">
        <div key={route.kind} className="w-full flex justify-center animate-fade-in">
          {route.kind === "home"   && <Home navigate={navigate} />}
          {route.kind === "host"   && <HostPage />}
          {route.kind === "client" && <ClientPage prefillCode={route.prefillCode} />}
        </div>
      </main>
    </div>
  );
}
