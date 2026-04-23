import { useEffect, useState } from "react";
import { Home } from "./pages/Home";
import { HostPage } from "./pages/Host";
import { ClientPage } from "./pages/Client";

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
    <div className="shell">
      <nav className="nav">
        <a className="logo" href="#/">
          <span className="logo-mark">RC</span>
          <span>Remote Access</span>
        </a>
        <div className="nav-spacer" />
        <a
          className={`nav-link ${route.kind === "host" ? "active" : ""}`}
          href="#/host"
          onClick={(e) => { e.preventDefault(); navigate("host"); }}
        >
          Host
        </a>
        <a
          className={`nav-link ${route.kind === "client" ? "active" : ""}`}
          href="#/client"
          onClick={(e) => { e.preventDefault(); navigate("client"); }}
        >
          Join
        </a>
      </nav>

      <main className="content">
        {route.kind === "home"   && <Home navigate={navigate} />}
        {route.kind === "host"   && <HostPage />}
        {route.kind === "client" && <ClientPage prefillCode={route.prefillCode} />}
      </main>
    </div>
  );
}
