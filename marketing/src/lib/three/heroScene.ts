/**
 * Hero scene — a translucent "phone" with floating chat bubbles.
 *
 * Returns a SceneHandle that can be `.dispose()`d when the section
 * scrolls out of view (or on page unload). The scene is silent and
 * respects `prefers-reduced-motion`; the caller (`scene-init.client.ts`)
 * is responsible for not instantiating it when the media query matches.
 */
import {
  CanvasTexture,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  createCamera,
  createRenderer,
  disposeScene,
  setupResize,
  type SceneHandle,
} from "./shared";

const BUBBLES: string[] = [
  "💬 ¿Teneis hueco mañana?",
  "🤖 ¡Te reservo!",
  "📅 Listo, te esperamos",
];

const createBubbleTexture = (text: string): CanvasTexture => {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  // Rounded rect background
  const r = 48;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(c.width - r, 0);
  ctx.quadraticCurveTo(c.width, 0, c.width, r);
  ctx.lineTo(c.width, c.height - r);
  ctx.quadraticCurveTo(c.width, c.height, c.width - r, c.height);
  ctx.lineTo(r, c.height);
  ctx.quadraticCurveTo(0, c.height, 0, c.height - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();
  // Text
  ctx.fillStyle = "#1e1b4b";
  ctx.font = "bold 56px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
};

export const createHeroScene = (canvas: HTMLCanvasElement): SceneHandle => {
  const renderer = createRenderer(canvas);
  const camera = createCamera(35);
  const scene = new Scene();
  scene.background = null;

  // Position the camera so the box is framed on the right side of the hero.
  camera.position.set(0, 0, 6);
  camera.lookAt(new Vector3(2, 0, 0));

  // Lights
  const hemi = new HemisphereLight(0xffffff, 0x4f46e5, 0.6);
  scene.add(hemi);
  const key = new DirectionalLight(0xffffff, 1.2);
  key.position.set(2, 4, 3);
  scene.add(key);
  const rim = new PointLight(0x8b5cf6, 2, 12);
  rim.position.set(-3, -2, 2);
  scene.add(rim);

  // Phone body (translucent rounded box)
  const phoneGeo = new RoundedBoxGeometry(1.4, 2.8, 0.18, 6, 0.18);
  const phoneMat = new MeshPhysicalMaterial({
    color: new Color(0x1e1b4b),
    transmission: 0.65,
    thickness: 0.5,
    roughness: 0.1,
    metalness: 0,
    ior: 1.45,
    clearcoat: 0.4,
    transparent: true,
    opacity: 0.95,
  });
  const phone = new Mesh(phoneGeo, phoneMat);
  phone.position.set(2, 0, 0);
  scene.add(phone);

  // Inner display (a flat emissive plane for the "screen on" effect)
  const screenGeo = new PlaneGeometry(1.2, 2.5);
  const screenMat = new MeshStandardMaterial({
    color: new Color(0x4f46e5),
    emissive: new Color(0x4f46e5),
    emissiveIntensity: 0.4,
  });
  const screen = new Mesh(screenGeo, screenMat);
  screen.position.set(2, 0, 0.1);
  scene.add(screen);

  // Chat bubbles as sprites
  const sprites: Array<{ sprite: Sprite; base: Vector3; phase: number }> = [];
  BUBBLES.forEach((text, i) => {
    const tex = createBubbleTexture(text);
    const mat = new SpriteMaterial({ map: tex, transparent: true });
    const sprite = new Sprite(mat);
    const base = new Vector3(2.5, 1.4 - i * 1.1, 0.5);
    sprite.position.copy(base);
    sprite.scale.set(1.6, 0.8, 1);
    scene.add(sprite);
    sprites.push({ sprite, base, phase: i * 0.7 });
  });

  const { resize, dispose: disposeResize } = setupResize(canvas, camera, renderer);
  resize(canvas.clientWidth || 800, canvas.clientHeight || 600);

  let raf = 0;
  const start = performance.now();
  const animate = () => {
    const t = (performance.now() - start) / 1000;
    // Slow auto-rotation
    phone.rotation.y = Math.sin(t * 0.3) * 0.15;
    screen.rotation.y = phone.rotation.y;
    // Float bubbles
    sprites.forEach(({ sprite, base, phase }) => {
      sprite.position.y = base.y + Math.sin(t + phase) * 0.08;
    });
    renderer.render(scene, camera);
    raf = requestAnimationFrame(animate);
  };
  raf = requestAnimationFrame(animate);

  return {
    renderer,
    camera,
    scene,
    resize,
    dispose: () => {
      cancelAnimationFrame(raf);
      disposeResize();
      disposeScene(scene);
      renderer.dispose();
    },
  };
};

// `PerspectiveCamera` is referenced in the imports for type clarity but
// the `createCamera` helper already returns the right type. Re-export
// to keep the type signature discoverable.
export type { PerspectiveCamera } from "three";
