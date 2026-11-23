import * as THREE from 'three/webgpu';
import { positionLocal, normalize, mix, color, smoothstep, pow } from 'three/tsl';

/**
 * Gradient sky dome written in TSL (Three Shading Language), which compiles to WGSL
 * on WebGPU (or GLSL on the WebGL2 fallback). Call `sky.position.copy(camera.position)`
 * each frame so it stays centered.
 */
export function makeSky({ top, horizon, ground, radius = 300 }) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  mat.fog = false;
  const h = normalize(positionLocal).y;
  const up = pow(smoothstep(0.0, 0.7, h), 0.8);
  const down = smoothstep(0.0, 0.2, h.negate());
  mat.colorNode = mix(mix(color(horizon), color(top), up), color(ground), down);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}
