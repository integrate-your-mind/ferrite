export const metadata = {
  title: "Ferrite 3D Tic Tac Toe with Three.js",
  description: "A Ferrite walkthrough for importing and mounting Three.js in a client route.",
  alternates: {
    canonical: "/blog/tic-tac-toe-3d",
  },
};

const exampleRoute = "/tic-tac-toe-3d";

export default function BlogThreeDTicTacToePost() {
  return (
    <article style={{ maxWidth: 900, margin: "0 auto", padding: "120px 22px 92px" }}>
      <div className="kicker">Demo Walkthrough</div>
      <h1 style={{ marginTop: "0.4rem", marginBottom: "0.8rem" }}>Build 3D Tic Tac Toe in Ferrite with Three.js</h1>
      <p style={{ color: "#4b5563", lineHeight: 1.6 }}>
        This is a practical walkthrough showing library import, mount lifecycle, and cleanup in a Ferrite client
        route.
      </p>

      <section style={{ marginTop: "2rem" }} aria-labelledby="step1">
        <h2 id="step1">Step 1: import Three.js explicitly</h2>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`import * as THREE from "three";`}</code>
        </pre>
      </section>

      <section style={{ marginTop: "2rem" }} aria-labelledby="step2">
        <h2 id="step2">Step 2: mount a renderer in a client effect</h2>
        <p>
          The route keeps browser-only rendering inside <code>useEffect</code> and stores handles in refs.
        </p>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`const mountRef = useRef<HTMLDivElement>(null);\nconst sceneRef = useRef<SceneResources | null>(null);`}</code>
        </pre>
      </section>

      <section style={{ marginTop: "2rem" }} aria-labelledby="step3">
        <h2 id="step3">Step 3: sync game state to meshes</h2>
        <p>Board state still lives in simple arrays like the 2-D demo. On every move, the effect writes matching X/O meshes into the Three.js group.</p>
      </section>

      <section style={{ marginTop: "2rem" }} aria-labelledby="step4">
        <h2 id="step4">Step 4: run and open</h2>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`pnpm build:example\ncargo run -p ferrite-cli -- dev --project examples/basic --request-path ${exampleRoute}`}</code>
        </pre>
      <p>
          Then open <code>{exampleRoute}</code> on the Ferrite example server.
      </p>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Source</h2>
        <p>
          Full source path: <code>examples/basic/app/tic-tac-toe-3d/page.tsx</code>.
        </p>
      </section>
    </article>
  );
}
