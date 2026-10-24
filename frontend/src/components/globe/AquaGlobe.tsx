import React, { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Zone } from "../../services/api";

interface AquaGlobeProps {
  zones: Zone[];
  selectedZone: Zone | null;
  onSelectZone: (zone: Zone) => void;
  isStormActive: boolean;
}

const BLR = { lat: 12.9716, lng: 77.5946 };
const R = 5;
const DEG = Math.PI / 180;

/** lat/lng to a point on a sphere of radius r (three.js convention, +y = north). */
function ll(lat: number, lng: number, r = R) {
  const phi = (90 - lat) * DEG;
  const theta = (lng + 180) * DEG;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

function riskColor(score: number) {
  if (score >= 0.85) return 0xf43f5e;
  if (score >= 0.65) return 0xfb923c;
  if (score >= 0.35) return 0xfbbf24;
  return 0x34d399;
}

function rainLabel(mmh: number) {
  if (mmh >= 30) return { text: "Very heavy", cls: "text-rose-300" };
  if (mmh >= 15) return { text: "Heavy", cls: "text-orange-300" };
  if (mmh >= 5) return { text: "Moderate", cls: "text-amber-200" };
  if (mmh >= 0.5) return { text: "Light", cls: "text-sky-200" };
  return { text: "Dry", cls: "text-slate-300" };
}

/** Procedural cloud texture (fractal value noise) so no extra download is needed. */
function cloudTexture() {
  const w = 1024, h = 512;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w, h);
  const N = 64;
  const grid = Array.from({ length: (N + 1) * (N / 2 + 1) }, () => Math.random());
  const at = (x: number, y: number) => grid[(y % (N / 2 + 1)) * (N + 1) + (x % (N + 1))];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (u: number, v: number) => {
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = smooth(u - x0), fy = smooth(v - y0);
    const a = at(x0, y0), b = at(x0 + 1, y0), c2 = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * fx) * (1 - fy) + (c2 + (d - c2) * fx) * fy;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0, amp = 0.55, f = 1;
      for (let o = 0; o < 5; o++) {
        v += amp * noise(((x / w) * 8 * f) % N, ((y / h) * 4 * f) % (N / 2));
        amp *= 0.5; f *= 2;
      }
      const a = Math.max(0, Math.min(1, (v - 0.5) * 3.2));
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const AquaGlobe: React.FC<AquaGlobeProps> = ({ zones, isStormActive }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const stormRef = useRef(isStormActive);
  stormRef.current = isStormActive;

  // Live rainfall from the latest predictions
  const rain = useMemo(() => {
    const p = zones.map((z) => z.current_prediction).filter(Boolean) as NonNullable<Zone["current_prediction"]>[];
    if (!p.length) return { now: 0, max: 0, maxZone: "", day: 0, next6: 0 };
    const now = p.reduce((s, x) => s + (x.rainfall_1h_mm ?? 0), 0) / p.length;
    const day = p.reduce((s, x) => s + (x.rainfall_24h_mm ?? 0), 0) / p.length;
    const next6 = p.reduce((s, x) => s + (x.forecast_6h_mm ?? 0), 0) / p.length;
    let maxI = 0;
    p.forEach((x, i) => { if ((x.rainfall_1h_mm ?? 0) > (p[maxI].rainfall_1h_mm ?? 0)) maxI = i; });
    const zi = zones.findIndex((z) => z.current_prediction === p[maxI]);
    return { now, max: p[maxI].rainfall_1h_mm ?? 0, maxZone: zones[zi]?.name ?? "", day, next6 };
  }, [zones]);
  // Visual intensity: what is falling now, or what is about to arrive (next 6 h)
  const rainRef = useRef(0);
  rainRef.current = Math.max(rain.now, rain.next6 / 6);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    // Fit the whole globe (plus atmosphere) into the box, centred, whatever its size.
    const fit = () => {
      const w = container.clientWidth || 600, h = container.clientHeight || 420;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      const half = Math.tan((camera.fov / 2) * DEG) * Math.min(1, camera.aspect);
      camera.position.set(0, 0, (R * 1.42) / half);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(container);

    // tilt (x) > spin (y) > earth. Bengaluru is turned to face the camera.
    const tilt = new THREE.Group();
    const spin = new THREE.Group();
    tilt.add(spin);
    scene.add(tilt);
    const blrDir = ll(BLR.lat, BLR.lng, 1);
    const baseY = -Math.atan2(blrDir.x, blrDir.z);
    tilt.rotation.x = BLR.lat * DEG * 0.75;
    spin.rotation.y = baseY;

    // Earth
    const earthMat = new THREE.MeshPhongMaterial({ color: 0x5b7fa8, emissive: 0x020a16, specular: 0x1d4e7a, shininess: 18 });
    new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}textures/earth.jpg`, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      earthMat.map = t;
      earthMat.color.set(0xb8cfe8);
      earthMat.needsUpdate = true;
    });
    spin.add(new THREE.Mesh(new THREE.SphereGeometry(R, 96, 96), earthMat));

    // Faint lat/long graticule
    const grat = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(R + 0.01, 24, 12)),
      new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.06 }));
    spin.add(grat);

    // Rain clouds (opacity follows live rainfall)
    const cloudMat = new THREE.MeshLambertMaterial({ map: cloudTexture(), transparent: true, opacity: 0.35, depthWrite: false });
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.018, 72, 72), cloudMat);
    spin.add(clouds);

    // Atmosphere glow (fresnel)
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.12, 64, 64),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        uniforms: { c: { value: new THREE.Color(0x22d3ee) } },
        vertexShader: "varying vec3 n; void main(){ n = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader: "uniform vec3 c; varying vec3 n; void main(){ float i = pow(0.72 - dot(n, vec3(0,0,1.0)), 3.0); gl_FragColor = vec4(c, 1.0) * i; }",
      }));
    scene.add(atmo);

    // Rain-cell over Bengaluru: a brighter cloud disc plus falling streaks
    const up = blrDir.clone();
    const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    const north = up.clone().cross(east).normalize();
    const glow = document.createElement("canvas");
    glow.width = glow.height = 128;
    const gg = glow.getContext("2d")!;
    const grad = gg.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(186,230,253,1)");
    grad.addColorStop(0.45, "rgba(125,211,252,0.55)");
    grad.addColorStop(1, "rgba(125,211,252,0)");
    gg.fillStyle = grad;
    gg.fillRect(0, 0, 128, 128);
    const cell = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 48),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(glow), transparent: true, opacity: 0.0, depthWrite: false }));
    cell.position.copy(up.clone().multiplyScalar(R * 1.03));
    cell.lookAt(up.clone().multiplyScalar(R * 3));
    spin.add(cell);

    const MAX = 600;
    const pos = new Float32Array(MAX * 6);
    const seeds = Array.from({ length: MAX }, () => {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 0.5;
      return { e: Math.cos(a) * d, n: Math.sin(a) * d, h: Math.random(), v: 0.6 + Math.random() * 0.8 };
    });
    const streakGeo = new THREE.BufferGeometry();
    streakGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const streakMat = new THREE.LineBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.85 });
    const streaks = new THREE.LineSegments(streakGeo, streakMat);
    spin.add(streaks);

    // 18 zones: drawn as a magnified cluster around Bengaluru so they are visible at globe scale
    const zoneGroup = new THREE.Group();
    const dotGeo = new THREE.SphereGeometry(0.055, 12, 12);
    zonesRef.current.forEach((z) => {
      const de = (z.center.lng - BLR.lng) * 9 * DEG * R, dn = (z.center.lat - BLR.lat) * 9 * DEG * R;
      const p = up.clone().multiplyScalar(R + 0.03).add(east.clone().multiplyScalar(de)).add(north.clone().multiplyScalar(dn));
      const m = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: riskColor(z.current_prediction?.risk_score ?? 0) }));
      m.position.copy(p.normalize().multiplyScalar(R + 0.03));
      m.userData.id = z.id;
      zoneGroup.add(m);
    });
    spin.add(zoneGroup);

    // Bengaluru pulse ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.2, 48),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.position.copy(up.clone().multiplyScalar(R + 0.035));
    ring.lookAt(up.clone().multiplyScalar(R * 3));
    spin.add(ring);

    // Light: sun from upper-left-front so the Bengaluru side is lit
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-6, 4, 10);
    scene.add(sun);

    // Drag to rotate, eases back to Bengaluru when released
    let drag = false, px = 0, py = 0, offY = 0, offX = 0;
    const down = (e: PointerEvent) => { drag = true; px = e.clientX; py = e.clientY; container.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      offY += (e.clientX - px) * 0.006; offX += (e.clientY - py) * 0.004;
      offX = Math.max(-0.8, Math.min(0.8, offX));
      px = e.clientX; py = e.clientY;
    };
    const upH = () => { drag = false; };
    container.addEventListener("pointerdown", down);
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerup", upH);
    container.addEventListener("pointercancel", upH);

    const clock = new THREE.Clock();
    let id = 0, last = 0;
    const tmp = new THREE.Vector3();
    const animate = () => {
      id = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const dt = Math.min(t - last, 0.05);
      last = t;

      if (!drag) { offY *= 0.96; offX *= 0.96; }
      spin.rotation.y = baseY + Math.sin(t * 0.18) * 0.2 + offY;
      tilt.rotation.x = BLR.lat * DEG * 0.75 + offX;
      clouds.rotation.y = t * 0.012;

      // Rain intensity drives cloud cover, the rain-cell and the number/speed of streaks
      const mmh = rainRef.current;
      const k = Math.min(1, mmh / 30);
      cloudMat.opacity += ((0.22 + 0.5 * k) - cloudMat.opacity) * 0.05;
      (cell.material as THREE.MeshBasicMaterial).opacity += ((mmh > 0.3 ? 0.12 + 0.3 * k : 0) - (cell.material as THREE.MeshBasicMaterial).opacity) * 0.05;
      const active = mmh > 0.3 ? Math.floor(120 + (MAX - 120) * k) : 0;
      streakMat.color.setHex(k > 0.66 ? 0xc4b5fd : 0x93c5fd);
      const len = 0.12 + 0.18 * k;
      for (let i = 0; i < MAX; i++) {
        const s = seeds[i];
        if (i >= active) { pos.fill(0, i * 6, i * 6 + 6); continue; }
        s.h -= dt * s.v * (0.5 + 1.6 * k);
        if (s.h < 0) s.h += 1;
        const base = up.clone().multiplyScalar(1).add(east.clone().multiplyScalar(s.e / R)).add(north.clone().multiplyScalar(s.n / R)).normalize();
        const r0 = R * 1.005 + s.h * 1.1;
        tmp.copy(base).multiplyScalar(r0);
        pos[i * 6] = tmp.x; pos[i * 6 + 1] = tmp.y; pos[i * 6 + 2] = tmp.z;
        tmp.copy(base).multiplyScalar(r0 + len);
        pos[i * 6 + 3] = tmp.x; pos[i * 6 + 4] = tmp.y; pos[i * 6 + 5] = tmp.z;
      }
      streakGeo.attributes.position.needsUpdate = true;

      // Live zone colours
      zoneGroup.children.forEach((m: any) => {
        const z = zonesRef.current.find((q) => q.id === m.userData.id);
        if (z) m.material.color.setHex(riskColor(z.current_prediction?.risk_score ?? 0));
      });

      const s = 1 + ((t * 0.8) % 1) * 2.2;
      ring.scale.set(s, s, 1);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - ((t * 0.8) % 1));

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
      container.removeEventListener("pointerdown", down);
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerup", upH);
      container.removeEventListener("pointercancel", upH);
      renderer.dispose();
      container.innerHTML = "";
    };
  }, [zones.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const lbl = rainLabel(rain.now);
  const incoming = rain.now < 0.5 && rain.next6 >= 3;

  return (
    <div className="absolute inset-0">
      <div ref={mountRef} className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing" />

      <div className="pointer-events-none absolute left-4 top-4 rounded-xl border border-white/10 bg-[#050c18]/70 px-3.5 py-2.5 backdrop-blur-md">
        <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-wider text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" /> Live rainfall · Bengaluru
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-extrabold tabular-nums text-white">{rain.now.toFixed(1)}</span>
          <span className="text-xs text-slate-400">mm/h city avg</span>
          <span className={`text-xs font-semibold ${incoming ? "text-amber-200" : lbl.cls}`}>{incoming ? "Rain approaching" : lbl.text}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          24 h: <b className="text-slate-200">{rain.day.toFixed(0)} mm</b> · next 6 h: <b className="text-slate-200">{rain.next6.toFixed(0)} mm</b>
        </div>
        {rain.max > 0.5 && <div className="text-[11px] text-slate-400">Wettest now: <b className="text-sky-200">{rain.maxZone}</b> {rain.max.toFixed(1)} mm/h</div>}
      </div>

      <div className="pointer-events-none absolute bottom-3 right-4 flex items-center gap-3 rounded-full border border-white/10 bg-[#050c18]/70 px-3 py-1.5 text-[10.5px] text-slate-400 backdrop-blur-md">
        {[["#34d399", "Low"], ["#fbbf24", "Medium"], ["#fb923c", "High"], ["#f43f5e", "Severe"]].map(([c, l]) => (
          <span key={l} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{l}</span>
        ))}
      </div>
      <div className="pointer-events-none absolute bottom-3 left-4 text-[10.5px] text-slate-500">Bengaluru · 12.97° N, 77.59° E · drag to rotate</div>
    </div>
  );
};
