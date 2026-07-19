"use client";

import { useEffect, useRef, useState } from "@ferrite/runtime";
import * as THREE from "three";
import "./page.css";

type SquareValue = "X" | "O" | null;
type BoardState = SquareValue[];

const boardSpacing = 1.25;
const pieceHover = 0.4;
const lines: Array<[number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const emptyBoard: BoardState = Array(9).fill(null);

const boardMetadata = {
  title: "Ferrite 3-D Tic Tac Toe",
  description: "Three.js stateful interactive demo using Ferrite client hooks.",
};

type SceneResources = {
  boardGroup: THREE.Group;
  pieceGroup: THREE.Group;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  animationId: number;
  resize: () => void;
};

export const metadata = boardMetadata;

function getWinner(squares: BoardState): SquareValue {
  for (const [a, b, c] of lines) {
    if (squares[a] !== null && squares[a] === squares[b] && squares[b] === squares[c]) {
      return squares[a];
    }
  }
  return null;
}

function boardCoordinate(index: number): [number, number] {
  const x = (index % 3) - 1;
  const z = Math.floor(index / 3) - 1;
  return [x * boardSpacing, z * boardSpacing];
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    for (const m of material) {
      m.dispose();
    }
    return;
  }

  material.dispose();
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      disposeMaterial(node.material);
    }
  });
}

function clearPieces(group: THREE.Group) {
  while (group.children.length > 0) {
    const piece = group.children.pop();
    if (!piece) {
      continue;
    }
    group.remove(piece);
    disposeObject(piece);
  }
}

function makeXPiece(): THREE.Group {
  const barGeometry = new THREE.BoxGeometry(0.95, 0.1, 0.08);
  const piece = new THREE.Group();

  const barA = new THREE.Mesh(
    barGeometry,
    new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0x450a0a, metalness: 0.15, roughness: 0.25 }),
  );
  const barB = new THREE.Mesh(
    barGeometry,
    new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0x450a0a, metalness: 0.15, roughness: 0.25 }),
  );

  barA.rotation.y = Math.PI / 4;
  barB.rotation.y = -Math.PI / 4;

  piece.add(barA, barB);
  return piece;
}

function makeOPiece(): THREE.Mesh {
  const geometry = new THREE.TorusGeometry(0.26, 0.08, 16, 48);
  const material = new THREE.MeshStandardMaterial({
    color: 0x22c55e,
    emissive: 0x08320f,
    metalness: 0.2,
    roughness: 0.4,
  });
  const piece = new THREE.Mesh(geometry, material);
  piece.rotation.x = Math.PI / 2;
  return piece;
}

function syncPieces(state: BoardState, pieceGroup: THREE.Group) {
  clearPieces(pieceGroup);

  for (let index = 0; index < state.length; index += 1) {
    const value = state[index];
    if (value === null) {
      continue;
    }

    const [x, z] = boardCoordinate(index);
    const piece = value === "X" ? makeXPiece() : makeOPiece();
    piece.position.set(x, pieceHover, z);
    pieceGroup.add(piece);
  }
}

export default function TicTacToeThreeDemo() {
  const sceneRef = useRef<SceneResources | null>(null);
  const [state, setState] = useState<BoardState>(emptyBoard);
  const [xIsNext, setXIsNext] = useState(true);

  const winner = getWinner(state);
  const draw = winner === null && state.every((value) => value !== null);
  const next = xIsNext ? "X" : "O";
  const status = winner ? `Winner: ${winner}` : draw ? "Draw" : `Next player: ${next}`;

  function playMove(index: number) {
    if (winner || state[index] !== null) {
      return;
    }

    const nextState = [...state];
    nextState[index] = next;
    setState(nextState);
    const resources = sceneRef.current;
    if (resources) {
      syncPieces(nextState, resources.pieceGroup);
    }
    setXIsNext((current) => !current);
  }

  function resetGame() {
    setState(emptyBoard);
    const resources = sceneRef.current;
    if (resources) {
      clearPieces(resources.pieceGroup);
    }
    setXIsNext(true);
  }

  useEffect(() => {
    const mount = typeof document === "undefined" ? null : document.getElementById("tic-tac-toe-3d-stage");
    if (!mount) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020817);
    const boardGroup = new THREE.Group();
    const pieceGroup = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    boardGroup.rotation.x = -0.42;
    boardGroup.add(pieceGroup);
    scene.add(boardGroup);

    const surfaceGeometry = new THREE.PlaneGeometry(boardSpacing * 3.3, boardSpacing * 3.3);
    const surfaceMaterial = new THREE.MeshStandardMaterial({
      color: 0x08162e,
      emissive: 0x011024,
      roughness: 0.4,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 0;
    surface.receiveShadow = true;
    boardGroup.add(surface);

    const lineMaterial = new THREE.MeshStandardMaterial({ color: 0x4f97d9 });
    const verticalLine = new THREE.BoxGeometry(0.08, 0.02, boardSpacing * 3);
    const horizontalLine = new THREE.BoxGeometry(boardSpacing * 3, 0.02, 0.08);
    for (let i = -1; i < 2; i += 2) {
      const v1 = new THREE.Mesh(verticalLine, lineMaterial);
      v1.position.set(i * boardSpacing, 0.01, 0);
      v1.receiveShadow = true;
      v1.castShadow = true;
      boardGroup.add(v1);

      const h1 = new THREE.Mesh(horizontalLine, lineMaterial);
      h1.position.set(0, 0.01, i * boardSpacing);
      h1.receiveShadow = true;
      h1.castShadow = true;
      boardGroup.add(h1);
    }

    const ambient = new THREE.AmbientLight(0x8ab0d4, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 4, 2);
    key.castShadow = true;
    const fill = new THREE.DirectionalLight(0x2f6fb8, 0.65);
    fill.position.set(-4, 3, -2);

    scene.add(ambient, key, fill);

    camera.position.set(0, 5.2, 7.2);
    camera.lookAt(0, 0.2, 0);

    const resize = () => {
      const width = Math.max(mount.clientWidth, 320);
      const height = Math.max(Math.min(mount.clientHeight, 560), 280);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    const animate = () => {
      boardGroup.rotation.y += 0.0018;
      renderer.render(scene, camera);
      sceneRef.current!.animationId = requestAnimationFrame(animate);
    };

    const resources: SceneResources = {
      boardGroup,
      pieceGroup,
      renderer,
      scene,
      camera,
      animationId: 0,
      resize,
    };
    sceneRef.current = resources;
    syncPieces(state, pieceGroup);
    resize();
    animate();

    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(resources.animationId);

      clearPieces(pieceGroup);
      clearPieces(boardGroup);
      renderer.dispose();

      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
      scene.clear();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const resources = sceneRef.current;
    if (!resources) {
      return;
    }

    syncPieces(state, resources.pieceGroup);
  }, [state]);

  return (
    <main className="tic-tac-toe-3d-demo" data-route="/tic-tac-toe-3d">
      <h1>3-D Tic Tac Toe in Ferrite</h1>
      <p className="tic-tac-toe-3d-note">
        Demonstrates importing an external library directly from the browser layer:
      </p>
      <pre className="tic-tac-toe-3d-code">
        <code>{`import * as THREE from "three";`}</code>
      </pre>
      <p className="tic-tac-toe-3d-status" role="status" aria-live="polite">
        {status}
      </p>
      <p className="tic-tac-toe-3d-copy">
        Click an empty square (top-down logic), and a 3D piece is added to that board position.
      </p>

      <div id="tic-tac-toe-3d-stage" className="tic-tac-toe-3d-stage" aria-label="3-D board render target" />

      <div className="tic-tac-toe-3d-board-controls" role="group" aria-label="Game board controls">
        <div className="tic-tac-toe-3d-grid">
          {state.map((value, index) => (
            <button
              type="button"
              key={index}
              className="tic-tac-toe-3d-square"
              onClick={() => playMove(index)}
            >
              {value === null ? "\u00a0" : value}
            </button>
          ))}
        </div>
        <button type="button" className="tic-tac-toe-3d-reset" onClick={resetGame}>
          Reset board
        </button>
      </div>
    </main>
  );
}
