import React, { useEffect, useMemo, useRef, useState } from "react";
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
  const [view, setView] = useState<"city" | "globe">("city");
  const viewRef = useRef(view);
  viewRef.current = view;
  const labelRef = useRef<HTMLDivElement>(null);

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

    let far = 30, near = R + 1.2;
    // Fit the whole globe (plus atmosphere) into the box, centred, whatever its size.
    const fit = () => {
      const w = container.clientWidth || 600, h = container.clientHeight || 420;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      const half = Math.tan((camera.fov / 2) * DEG) * Math.min(1, camera.aspect);
      far = (R * 1.42) / half;           // whole globe in frame
      near = R + 0.42 / half;            // ~10 degrees of ground around Bengaluru
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
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
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

    // Everything Bengaluru-specific lives in a flat local frame sitting on the surface at the city:
    // x = east, y = north, z = up (1 unit = 1 world unit).
    const up = blrDir.clone();
    const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    const north = up.clone().cross(east).normalize();
    const local = new THREE.Group();
    local.matrixAutoUpdate = false;
    local.matrix.makeBasis(east, north, up).setPosition(up.clone().multiplyScalar(R + 0.004));
    spin.add(local);

    // City layer: the 18 BBMP zones, enlarged around the city centre so they read at this scale
    const city = new THREE.Group();
    local.add(city);
    const toLocal = (lng: number, lat: number) =>
      new THREE.Vector3((lng - BLR.lng) * DEG * R * Math.cos(BLR.lat * DEG), (lat - BLR.lat) * DEG * R, 0);
    const outlineMats: THREE.LineBasicMaterial[] = [];
    const fillMats: THREE.MeshBasicMaterial[] = [];
    const dots: THREE.Mesh[] = [];
    const dotGeo = new THREE.CircleGeometry(1, 20);
    zonesRef.current.forEach((z) => {
      const col = riskColor(z.current_prediction?.risk_score ?? 0);
      const poly = (z.boundary_polygon ?? []).map(([lng, lat]) => toLocal(lng, lat));
      if (poly.length >= 3) {
        const shape = new THREE.Shape(poly.map((v) => new THREE.Vector2(v.x, v.y)));
        const fm = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
        const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), fm);
        fill.userData.id = z.id;
        city.add(fill);
        fillMats.push(fm);
        const om = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.95 });
        const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(poly), om);
        line.position.z = 0.0005;
        line.userData.id = z.id;
        city.add(line);
        outlineMats.push(om);
      }
      const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: col, depthWrite: false }));
      dot.position.copy(toLocal(z.center.lng, z.center.lat)).setZ(0.001);
      dot.userData.id = z.id;
      city.add(dot);
      dots.push(dot);
    });

    // Pulse ring at the city centre
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    local.add(ring);

    // Rain layer: a soft rain-cell glow plus falling streaks
    const rainLayer = new THREE.Group();
    local.add(rainLayer);
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
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(glow), transparent: true, opacity: 0.0, depthWrite: false }));
    cell.position.z = 0.02;
    rainLayer.add(cell);

    const MAX = 700;
    const pos = new Float32Array(MAX * 6);
    const seeds = Array.from({ length: MAX }, () => {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random());
      return { x: Math.cos(a) * d, y: Math.sin(a) * d, h: Math.random(), v: 0.6 + Math.random() * 0.8 };
    });
    const streakGeo = new THREE.BufferGeometry();
    streakGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const streakMat = new THREE.LineBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.85 });
    rainLayer.add(new THREE.LineSegments(streakGeo, streakMat));

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
    let id = 0, last = 0, zoom = 0;
    const lerp = (x: number, y: number, k: number) => x + (y - x) * k;
    const look = new THREE.Vector3();
    const proj = new THREE.Vector3();
    const animate = () => {
      id = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const dt = Math.min(t - last, 0.05);
      last = t;

      // Fly between the whole globe (zoom 0) and the Bengaluru close-up (zoom 1)
      zoom += ((viewRef.current === "city" ? 1 : 0) - zoom) * Math.min(1, dt * 1.6);
      const z = zoom * zoom * (3 - 2 * zoom);

      if (!drag) { offY *= 0.95; offX *= 0.95; }
      const sway = lerp(0.2, 0.015, z);
      spin.rotation.y = baseY + Math.sin(t * 0.18) * sway + offY * lerp(1, 0.25, z);
      tilt.rotation.x = BLR.lat * DEG * lerp(0.75, 1, z) + offX * lerp(1, 0.25, z);
      clouds.rotation.y = t * 0.012;

      // Close-up: camera drops a little and looks down at the city at an angle (a 3D "tilted map" feel)
      const dist = lerp(far, near, z);
      camera.position.set(0, -z * (near - R) * 0.75, dist);
      look.set(0, 0, z * R);
      camera.lookAt(look);

      // City layer scale: enlarged a lot on the globe, less in the close-up
      const mag = lerp(9, 16, z);
      city.scale.setScalar(mag);
      const dotR = lerp(0.05, 0.0055, z) / mag;
      dots.forEach((d) => d.scale.setScalar(dotR));
      const rs = lerp(0.6, 0.3, z);           // rain-cell radius in world units
      rainLayer.scale.set(rs, rs, lerp(1.1, 0.16, z));

      // Rain intensity drives cloud cover, the rain-cell and the number/speed of streaks
      const mmh = rainRef.current;
      const k = Math.min(1, mmh / 30);
      cloudMat.opacity += ((0.22 + 0.5 * k) * lerp(1, 0.45, z) - cloudMat.opacity) * 0.05;
      const cm = cell.material as THREE.MeshBasicMaterial;
      cm.opacity += ((mmh > 0.5 ? 0.12 + 0.3 * k : 0) - cm.opacity) * 0.05;
      const active = mmh > 0.5 ? Math.floor((150 + (MAX - 150) * k) * lerp(1, 0.6, z)) : 0;
      streakMat.color.setHex(k > 0.66 ? 0xc4b5fd : 0x93c5fd);
      const len = 0.08 + 0.14 * k;
      for (let i = 0; i < MAX; i++) {
        const s = seeds[i];
        if (i >= active) { pos.fill(0, i * 6, i * 6 + 6); continue; }
        s.h -= dt * s.v * (0.5 + 1.6 * k);
        if (s.h < 0) s.h += 1;
        pos[i * 6] = s.x; pos[i * 6 + 1] = s.y; pos[i * 6 + 2] = s.h;
        pos[i * 6 + 3] = s.x; pos[i * 6 + 4] = s.y; pos[i * 6 + 5] = s.h + len;
      }
      streakGeo.attributes.position.needsUpdate = true;

      // Live zone colours
      city.children.forEach((m: any) => {
        const zn = zonesRef.current.find((q) => q.id === m.userData.id);
        if (zn) m.material.color.setHex(riskColor(zn.current_prediction?.risk_score ?? 0));
      });

      const ph = (t * 0.8) % 1;
      const rr = lerp(0.18, 0.2, z) * (0.6 + ph * 1.2);
      ring.scale.set(rr, rr, 1);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - ph);

      // City label follows Bengaluru on screen
      if (labelRef.current) {
        proj.set(0, 0, 0).applyMatrix4(local.matrixWorld).project(camera);
        const w = container.clientWidth, h = container.clientHeight;
        labelRef.current.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px)`;
        labelRef.current.style.opacity = String(Math.max(0, z * 1.4 - 0.4));
      }

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

      <div ref={labelRef} className="pointer-events-none absolute left-0 top-0 opacity-0">
        <div className="-translate-x-1/2 translate-y-[95px] whitespace-nowrap rounded-full border border-cyan-300/40 bg-[#050c18]/80 px-2.5 py-1 text-[11px] font-semibold text-cyan-100 backdrop-blur">
          Bengaluru · 18 BBMP zones
        </div>
      </div>

      <div className="absolute right-4 top-4 flex rounded-full border border-white/10 bg-[#050c18]/70 p-0.5 text-[11px] backdrop-blur-md">
        {(["city", "globe"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`rounded-full px-3 py-1 font-semibold transition ${view === v ? "bg-cyan-400 text-[#04121f]" : "text-slate-300 hover:text-white"}`}>
            {v === "city" ? "Bengaluru" : "Globe"}
          </button>
        ))}
      </div>

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
      <div className="pointer-events-none absolute bottom-3 left-4 text-[10.5px] text-slate-500">Zones enlarged · drag to look around</div>
    </div>
  );
};
