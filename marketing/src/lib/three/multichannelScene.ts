/**
 * Multichannel scene — a central phone with 4 orbiting channel icons.
 *
 * Channels orbit at different speeds for an organic feel. The renderer
 * is mouse-tracking (parallax) on desktop. On mobile, auto-rotation
 * runs unconditionally and tap-to-highlight is emitted via a custom
 * event (`multichannel-icon-click`) that the page handler picks up.
 */
import {
  Color,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector2,
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

type ChannelKey = "facebook" | "instagram" | "telegram" | "web";

interface ChannelDef {
  key: ChannelKey;
  name: string;
  color: number;
  build: () => Mesh;
}

const CHANNELS: ChannelDef[] = [
  {
    key: "facebook",
    color: 0x1877f2,
    name: "Facebook Messenger",
    build: () =>
      new Mesh(
        new SphereGeometry(0.42, 32, 32),
        new MeshStandardMaterial({ color: 0x1877f2, roughness: 0.3 }),
      ),
  },
  {
    key: "instagram",
    color: 0xe1306c,
    name: "Instagram DMs",
    build: () =>
      new Mesh(
        new TorusGeometry(0.4, 0.14, 16, 64),
        new MeshStandardMaterial({ color: 0xe1306c, roughness: 0.3 }),
      ),
  },
  {
    key: "telegram",
    color: 0x0088cc,
    name: "Telegram",
    build: () =>
      new Mesh(
        new CylinderGeometry(0.3, 0.3, 0.16, 32),
        new MeshStandardMaterial({ color: 0x0088cc, roughness: 0.3 }),
      ),
  },
  {
    key: "web",
    color: 0x4f46e5,
    name: "Web (en la app)",
    build: () =>
      new Mesh(
        new RingGeometry(0.3, 0.45, 32),
        new MeshStandardMaterial({ color: 0x4f46e5, roughness: 0.3, side: 2 }),
      ),
  },
];

export const createMultichannelScene = (
  canvas: HTMLCanvasElement,
  onChannelClick: (key: ChannelKey, name: string) => void,
): SceneHandle => {
  const renderer = createRenderer(canvas);
  const camera = createCamera(40);
  const scene = new Scene();
  camera.position.set(0, 0, 7);
  camera.lookAt(new Vector3(0, 0, 0));

  scene.add(new HemisphereLight(0xffffff, 0x4f46e5, 0.7));
  const key = new DirectionalLight(0xffffff, 1.0);
  key.position.set(2, 3, 4);
  scene.add(key);
  const rim = new PointLight(0x8b5cf6, 1.5, 12);
  rim.position.set(-3, -2, 3);
  scene.add(rim);

  // Central phone
  const phoneGeo = new RoundedBoxGeometry(1.6, 3.0, 0.2, 6, 0.2);
  const phoneMat = new MeshPhysicalMaterial({
    color: new Color(0x312e81),
    roughness: 0.2,
    metalness: 0.1,
    clearcoat: 0.6,
  });
  const phone = new Mesh(phoneGeo, phoneMat);
  scene.add(phone);

  const screenGeo = new PlaneGeometry(1.4, 2.7);
  const screenMat = new MeshStandardMaterial({
    color: new Color(0x4f46e5),
    emissive: new Color(0x4f46e5),
    emissiveIntensity: 0.5,
  });
  const screen = new Mesh(screenGeo, screenMat);
  screen.position.z = 0.11;
  phone.add(screen);

  // Orbiting channels
  const orbiters: Array<{
    mesh: Mesh;
    def: ChannelDef;
    baseAngle: number;
    speed: number;
    radius: number;
  }> = [];
  CHANNELS.forEach((def, i) => {
    const mesh = def.build();
    mesh.userData = { channelKey: def.key, channelName: def.name };
    scene.add(mesh);
    orbiters.push({
      mesh,
      def,
      baseAngle: (i / CHANNELS.length) * Math.PI * 2,
      speed: 0.25 + (i % 2) * 0.1,
      radius: 3.5,
    });
  });

  // Picking
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const updatePointer = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  };
  const handleClick = (e: PointerEvent) => {
    updatePointer(e);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      orbiters.map((o) => o.mesh),
      false,
    );
    if (hits.length > 0) {
      const obj = hits[0].object;
      const { channelKey, channelName } = obj.userData as {
        channelKey: ChannelKey;
        channelName: string;
      };
      onChannelClick(channelKey, channelName);
    }
  };
  canvas.addEventListener("pointerdown", handleClick);

  // Parallax on desktop
  const mouseTarget = new Vector2(0, 0);
  const handleMove = (e: PointerEvent) => {
    updatePointer(e);
    mouseTarget.x = pointer.x * 0.5;
    mouseTarget.y = pointer.y * 0.3;
  };
  canvas.addEventListener("pointermove", handleMove);

  const { resize, dispose: disposeResize } = setupResize(canvas, camera, renderer);
  resize(canvas.clientWidth || 800, canvas.clientHeight || 600);

  let raf = 0;
  const start = performance.now();
  const animate = () => {
    const t = (performance.now() - start) / 1000;
    orbiters.forEach((o) => {
      const angle = o.baseAngle + t * o.speed;
      o.mesh.position.set(
        Math.cos(angle) * o.radius,
        Math.sin(angle * 0.7) * 0.5,
        Math.sin(angle) * o.radius * 0.5,
      );
      o.mesh.rotation.x += 0.005;
      o.mesh.rotation.y += 0.01;
    });
    camera.position.x += (mouseTarget.x - camera.position.x) * 0.05;
    camera.position.y += (mouseTarget.y - camera.position.y) * 0.05;
    camera.lookAt(0, 0, 0);
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
      canvas.removeEventListener("pointerdown", handleClick);
      canvas.removeEventListener("pointermove", handleMove);
      disposeResize();
      disposeScene(scene);
      renderer.dispose();
    },
  };
};

export type { ChannelKey };
