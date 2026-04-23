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
    <div className="card wide">
      <h1>Remote Access</h1>
      <p className="lede">
        Share your screen with someone you trust, with an explicit approval
        step on every connection. No auto-accept, no background sharing —
        nothing happens without your click.
      </p>

      <div className="home-choices">
        <a
          className="home-choice"
          href="#/host"
          onClick={(e) => { e.preventDefault(); navigate("host"); }}
        >
          <span className="mark">🖥</span>
          <span className="title">Share my screen (Host)</span>
          <span className="desc">
            Generate a one-time code. A client must enter it and you must
            approve their request before anything starts.
          </span>
        </a>
        <a
          className="home-choice"
          href="#/client"
          onClick={(e) => { e.preventDefault(); navigate("client"); }}
        >
          <span className="mark">👀</span>
          <span className="title">View a shared screen (Client)</span>
          <span className="desc">
            Enter the code the host gave you. You'll see "waiting for
            approval" until they accept — then the screen appears.
          </span>
        </a>
      </div>

      <div className="alert info" style={{ marginTop: 24 }}>
        <strong>Privacy:</strong> screen sharing runs peer-to-peer via WebRTC.
        The server only relays the one-time approval handshake — your screen
        contents never pass through it.
      </div>
    </div>
  );
}
