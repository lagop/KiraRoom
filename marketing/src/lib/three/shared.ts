/**
 * Shared Three.js helpers used by heroScene.ts and multichannelScene.ts.
 *
 * Centralises renderer / camera / resize setup so both scenes can
 * share the same defaults and disposal pattern. Kept framework-free
 * and tree-shake-friendly so it only lands in the bundle when
 * `scripts/scene-init.client.ts` actually imports it.
 */
import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  WebGLRenderer,
  type Scene,
} from "three";

export interface SceneHandle {
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  scene: Scene;
  dispose: () => void;
  resize: (width: number, height: number) => void;
}

export const createRenderer = (canvas: HTMLCanvasElement): WebGLRenderer => {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  return renderer;
};

export const createCamera = (fov = 35): PerspectiveCamera => {
  return new PerspectiveCamera(fov, 1, 0.1, 100);
};

export const setupResize = (
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  renderer: WebGLRenderer,
): { resize: (w: number, h: number) => void; dispose: () => void } => {
  let raf = 0;
  const ro = new ResizeObserver((entries) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width === 0 || height === 0) continue;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    });
  });
  ro.observe(canvas);
  return {
    resize: (w, h) => {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
};

/**
 * Dispose all geometries and materials in a scene to free GPU memory.
 */
export const disposeScene = (scene: Scene): void => {
  scene.traverse((obj: import("three").Object3D) => {
    const mesh = obj as unknown as {
      geometry?: { dispose: () => void };
      material?:
        | { dispose: () => void }
        | { dispose: () => void }[];
    };
    if (mesh.geometry && typeof mesh.geometry.dispose === "function") {
      mesh.geometry.dispose();
    }
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m: { dispose: () => void }) => m.dispose());
    } else if (mesh.material && typeof mesh.material.dispose === "function") {
      mesh.material.dispose();
    }
  });
};
