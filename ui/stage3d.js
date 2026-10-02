/* Opaya stage: the Three.js layer under the management screen. Two things live here:
   - the hero scene, an agent at the center of what it is connected to (its machine, Docker, git, keys, skills), and
   - flights, short 3D effects over the whole window when something moves: a key given to an agent, an agent cloned
     or dockerized, commits pushed to a remote.
   Three.js is imported only when the first scene or flight is needed. Nothing renders while nothing moves: the hero
   draws at most 30 frames a second while it is on screen and the window is visible, and the flight layer stops its
   loop when the last flight lands. Without WebGL, or with reduced motion, flights fall back to light DOM animation. */
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let THREE = null, loading = null, webgl = null;
function load() {
  if (THREE) return Promise.resolve(THREE);
  if (!loading) loading = import('./vendor/three.module.js').then(m => (THREE = m)).catch(error => { webgl = false; throw error; });
  return loading;
}
function canWebgl() {
  if (webgl !== null) return webgl;
  try { const c = document.createElement('canvas'); webgl = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { webgl = false; }
  return webgl;
}
export const COLORS = { key: 0xf5c35b, docker: 0x4aa8ff, git: 0xf0883e, clone: 0x6ee7a8, skill: 0xb794f6, chat: 0x6ee7a8, machine: 0x9fb4c0, danger: 0xf7a59c };
const css = n => '#' + n.toString(16).padStart(6, '0');
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const back = t => { const c = 1.70158, d = c + 1; return 1 + d * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

// ---- Glyphs: small vector icons drawn once on a canvas, used as sprite textures ----------------------------------
const glyphCache = new Map();
function glyph(kind, color) {
  const key = kind + color; if (glyphCache.has(key)) return glyphCache.get(key);
  const s = 128, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  const tone = css(color);
  const halo = g.createRadialGradient(64, 64, 20, 64, 64, 64); halo.addColorStop(0, tone + '55'); halo.addColorStop(1, tone + '00');
  g.fillStyle = halo; g.fillRect(0, 0, s, s);
  g.beginPath(); g.arc(64, 64, 34, 0, Math.PI * 2); g.fillStyle = '#121518'; g.fill(); g.lineWidth = 3; g.strokeStyle = tone; g.stroke();
  g.strokeStyle = tone; g.fillStyle = tone; g.lineWidth = 4; g.lineCap = g.lineJoin = 'round';
  const path = { // each in a 40x40 box centered on 64,64
    machine: () => { g.strokeRect(46, 48, 36, 24); g.beginPath(); g.moveTo(58, 80); g.lineTo(70, 80); g.moveTo(64, 72); g.lineTo(64, 80); g.stroke(); },
    docker: () => { for (const [x, y] of [[46, 62], [58, 62], [70, 62], [52, 50], [64, 50]]) g.strokeRect(x, y, 10, 10); g.beginPath(); g.moveTo(44, 76); g.quadraticCurveTo(64, 86, 84, 74); g.stroke(); },
    git: () => { g.beginPath(); g.moveTo(54, 46); g.lineTo(54, 82); g.moveTo(54, 66); g.quadraticCurveTo(74, 66, 74, 52); g.stroke(); for (const [x, y] of [[54, 46], [54, 82], [74, 50]]) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); } },
    key: () => { g.beginPath(); g.arc(54, 58, 9, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.moveTo(61, 65); g.lineTo(80, 84); g.moveTo(72, 76); g.lineTo(78, 70); g.moveTo(76, 80); g.lineTo(81, 75); g.stroke(); },
    skill: () => { g.beginPath(); for (let i = 0; i < 8; i++) { const r = i % 2 ? 7 : 18, a = i * Math.PI / 4 - Math.PI / 2; g.lineTo(64 + r * Math.cos(a), 64 + r * Math.sin(a)); } g.closePath(); g.fill(); },
    chat: () => { g.beginPath(); if (g.roundRect) g.roundRect(46, 48, 36, 26, 7); else g.rect(46, 48, 36, 26); g.stroke(); g.beginPath(); g.moveTo(54, 74); g.lineTo(52, 84); g.lineTo(62, 74); g.stroke(); },
    clone: () => { g.strokeRect(46, 50, 26, 26); g.strokeRect(56, 42, 26, 26); }
  }[kind] || (() => { g.beginPath(); g.arc(64, 64, 8, 0, Math.PI * 2); g.fill(); });
  path();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; glyphCache.set(key, tex); return tex;
}
let glowTex = null;
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.25, 'rgba(255,255,255,.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64); glowTex = new THREE.CanvasTexture(c); return glowTex;
}

// ---- Hero: the agent and what it is connected to -------------------------------------------------------------------
// One renderer for every agent: the wrapper element moves between management screens, which keeps its WebGL context.
const STATUS = { connected: 0x6ee7a8, working: 0x7cf3c0, connecting: 0xf5c35b, error: 0xf7a59c, disconnected: 0x7d8a92 };
class Hero {
  constructor() {
    this.el = document.createElement('div'); this.el.className = 'stage-hero';
    this.canvas = document.createElement('canvas'); this.canvas.className = 'stage-hero-canvas'; this.el.append(this.canvas);
    this.labels = document.createElement('div'); this.labels.className = 'stage-hero-labels'; this.el.append(this.labels);
    this.opts = { status: 'disconnected', nodes: [], busy: false };
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 }; this.last = 0; this.entered = 0;
    this.ready = load().then(() => this.build()).catch(() => { this.el.classList.add('stage-static'); });
  }
  build() {
    if (!canWebgl()) throw new Error('No WebGL');
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.scene = new T.Scene(); this.camera = new T.PerspectiveCamera(40, 2, .1, 100); this.camera.position.set(0, 0, 8);
    this.world = new T.Group(); this.scene.add(this.world);
    // Background dust, drifting slowly.
    const n = 160, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - .5) * 30; pos[i * 3 + 1] = (Math.random() - .5) * 14; pos[i * 3 + 2] = -Math.random() * 14 + 2; }
    const dust = new T.BufferGeometry(); dust.setAttribute('position', new T.BufferAttribute(pos, 3));
    this.dust = new T.Points(dust, new T.PointsMaterial({ size: .04, color: 0x6ee7a8, transparent: true, opacity: .22, depthWrite: false, blending: T.AdditiveBlending }));
    this.scene.add(this.dust);
    // The agent: a faceted core, a wire shell and a soft glow.
    this.coreMat = new T.MeshStandardMaterial({ color: 0x0e1a14, emissive: 0x6ee7a8, emissiveIntensity: .35, metalness: .4, roughness: .35, flatShading: true });
    this.core = new T.Mesh(new T.IcosahedronGeometry(1, 1), this.coreMat);
    this.shellMat = new T.MeshBasicMaterial({ color: 0x6ee7a8, wireframe: true, transparent: true, opacity: .28 });
    this.shell = new T.Mesh(new T.IcosahedronGeometry(1.45, 1), this.shellMat);
    this.halo = new T.Sprite(new T.SpriteMaterial({ map: glow(), color: 0x6ee7a8, transparent: true, opacity: .55, depthWrite: false, blending: T.AdditiveBlending }));
    this.halo.scale.setScalar(5.2);
    this.world.add(this.halo, this.core, this.shell);
    this.scene.add(new T.AmbientLight(0xffffff, .55)); const key = new T.DirectionalLight(0xffffff, 1.4); key.position.set(3, 4, 6); this.scene.add(key);
    // Orbit rings.
    this.rings = [3.7, 4.7].map((r, i) => { const pts = []; for (let k = 0; k <= 128; k++) { const a = k / 128 * Math.PI * 2; pts.push(new T.Vector3(Math.cos(a) * r, Math.sin(a) * r * .34, 0)); } const line = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: 0x6ee7a8, transparent: true, opacity: i ? .10 : .18 })); line.rotation.z = i ? .22 : -.12; this.world.add(line); return line; });
    this.sats = []; this.packets = [];
    this.resize(); this.applyNodes();
    // The wrapper moves between screens, so visibility is checked each frame; scrolling it back into view resumes it.
    document.addEventListener('scroll', () => this.kick(), { capture: true, passive: true });
    this.el.addEventListener('pointermove', e => { const r = this.el.getBoundingClientRect(); this.pointer.tx = (e.clientX - r.left) / r.width - .5; this.pointer.ty = (e.clientY - r.top) / r.height - .5; this.kick(); });
    this.el.addEventListener('pointerleave', () => { this.pointer.tx = this.pointer.ty = 0; });
    new ResizeObserver(() => { this.resize(); this.kick(); }).observe(this.el);
    document.addEventListener('visibilitychange', () => this.kick());
    this.entered = performance.now(); this.kick();
  }
  resize() {
    if (!this.renderer) return; const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    // The constellation sits on the right; the agent card covers the left of the hero.
    const half = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.position.z * this.camera.aspect;
    // In the compact hero (the management screen) the agent card covers more: the scene sits further right, smaller.
    this.compact = !!this.el.closest('.mg-hero-compact');
    this.world.position.x = w < 720 ? 0 : half * (this.compact ? .72 : .36); this.world.scale.setScalar(this.compact ? .62 : 1); this.dust.position.x = this.world.position.x * .5;
  }
  set(opts) {
    const agentChanged = opts.agent && opts.agent !== this.opts.agent;
    this.opts = { ...this.opts, ...opts };
    if (!this.renderer) return;
    this.resize(); this.applyNodes(); if (agentChanged) this.entered = performance.now();
    this.kick();
  }
  applyNodes() {
    const T = THREE, col = STATUS[this.opts.busy ? 'working' : this.opts.status] ?? STATUS.disconnected;
    this.coreMat.emissive.setHex(col); this.shellMat.color.setHex(col); this.halo.material.color.setHex(col); this.dust.material.color.setHex(col);
    for (const r of this.rings) r.material.color.setHex(col);
    const want = this.opts.nodes.slice(0, 7), sig = want.map(n => n.kind + n.label + (n.on ? 1 : 0)).join('|');
    if (sig === this.sig) return; this.sig = sig;
    for (const s of this.sats) { this.world.remove(s.sprite, s.line); s.line.geometry.dispose(); s.label.remove(); }
    for (const p of this.packets) this.world.remove(p);
    this.sats = []; this.packets = [];
    want.forEach((n, i) => {
      const color = COLORS[n.kind] ?? 0x9fb4c0;
      const sprite = new T.Sprite(new T.SpriteMaterial({ map: glyph(n.kind, color), transparent: true, depthWrite: false, opacity: n.on === false ? .45 : 1 }));
      sprite.scale.setScalar(.95);
      const line = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]), new T.LineBasicMaterial({ color, transparent: true, opacity: n.on === false ? .08 : .28 }));
      const label = document.createElement('span'); label.className = 'stage-label'; label.textContent = n.label; label.style.setProperty('--c', css(color)); if (n.on === false) label.classList.add('off'); this.labels.append(label);
      const sat = { sprite, line, label, color, angle: i / want.length * Math.PI * 2 + .4, radius: 3.7, tilt: -.12, on: n.on !== false, pulse: 0, kind: n.kind };
      this.world.add(line, sprite); this.sats.push(sat);
      // A packet travels between the agent and each live connection.
      if (sat.on) { const p = new T.Sprite(new T.SpriteMaterial({ map: glow(), color, transparent: true, depthWrite: false, blending: T.AdditiveBlending })); p.scale.setScalar(.32); p.userData = { sat, t: Math.random() }; this.world.add(p); this.packets.push(p); }
    });
  }
  pulse(kind) { for (const s of this.sats) if (s.kind === kind) s.pulse = 1; this.kick(); }
  // Where a satellite is on the page (for flights that start or land on it).
  rectOf(kind) {
    const s = this.sats.find(x => x.kind === kind); if (!s || !this.renderer) return null;
    const v = s.sprite.getWorldPosition(new THREE.Vector3()).project(this.camera), r = this.el.getBoundingClientRect();
    const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height; return { left: x - 14, top: y - 14, width: 28, height: 28 };
  }
  kick() { if (!this.frame && this.renderer) this.frame = requestAnimationFrame(t => this.tick(t)); }
  tick(now) {
    this.frame = 0;
    const r = this.el.getBoundingClientRect();
    if (!this.el.isConnected || document.hidden || r.bottom <= 0 || r.top >= innerHeight || !r.width) return; // resumes on kick()
    const still = reduced();
    if (!still && now - this.last < 32) { this.kick(); return; }
    const dt = Math.min(.05, (now - (this.last || now)) / 1000); this.last = now;
    const speed = this.opts.busy ? 2.6 : this.opts.status === 'connected' ? 1 : .35, t = now / 1000;
    const enter = Math.min(1, (now - this.entered) / 1100), e = still ? 1 : back(enter);
    const p = this.pointer; p.x += (p.tx - p.x) * .08; p.y += (p.ty - p.y) * .08;
    this.camera.position.x = p.x * 1.2; this.camera.position.y = -p.y * .8; this.camera.position.z = 8 + (1 - e) * 5; this.camera.lookAt(this.compact ? 0 : this.world.position.x * .6, 0, 0);
    this.core.rotation.y += dt * .35 * speed; this.core.rotation.x += dt * .12 * speed; this.shell.rotation.y -= dt * .18 * speed; this.shell.rotation.z += dt * .05;
    const breathe = 1 + Math.sin(t * (this.opts.busy ? 4 : 1.6)) * .04; this.core.scale.setScalar(e * breathe); this.shell.scale.setScalar(e); this.halo.scale.setScalar(5.2 * e * (.95 + Math.sin(t * 1.3) * .05));
    this.dust.rotation.y += dt * .01; this.dust.position.y = Math.sin(t * .2) * .2;
    const v = new THREE.Vector3();
    for (const s of this.sats) {
      s.angle += dt * .06 * speed;
      const x = Math.cos(s.angle) * s.radius * e, y0 = Math.sin(s.angle) * s.radius * .34 * e;
      const y = x * Math.sin(s.tilt) + y0 * Math.cos(s.tilt), xx = x * Math.cos(s.tilt) - y0 * Math.sin(s.tilt), z = Math.sin(s.angle) * .8;
      s.sprite.position.set(xx, y, z); s.pulse = Math.max(0, s.pulse - dt * 1.4);
      s.sprite.scale.setScalar((.95 + s.pulse * .9) * (z < 0 ? .82 : 1));
      const a = s.line.geometry.attributes.position.array; a[3] = xx; a[4] = y; a[5] = z; s.line.geometry.attributes.position.needsUpdate = true;
      s.line.material.opacity = (s.on ? .28 : .08) + s.pulse * .6;
      s.sprite.getWorldPosition(v); v.project(this.camera);
      s.label.style.transform = `translate(${(v.x + 1) / 2 * r.width}px,${(1 - v.y) / 2 * r.height + 22}px) translate(-50%,0)`;
      s.label.style.opacity = String(Math.max(0, Math.min(1, e * 1.2 - .2)) * (z < -.3 ? .55 : 1));
    }
    for (const p of this.packets) { const d = p.userData; d.t = (d.t + dt * .45 * speed) % 1; const s = d.sat.sprite.position, k = d.sat.kind === 'key' || d.sat.kind === 'skill' ? 1 - d.t : d.t; p.position.set(s.x * k, s.y * k, s.z * k); p.material.opacity = Math.sin(d.t * Math.PI) * .9; }
    this.renderer.render(this.scene, this.camera);
    if (!still) this.kick();
  }
}
let hero = null;
export function heroStage() { if (!hero) hero = new Hero(); return hero; }

// ---- Flights: 3D effects over the whole window ---------------------------------------------------------------------
class Flights {
  constructor() { this.items = []; this.frame = 0; }
  init() {
    if (this.renderer) return; const T = THREE;
    this.canvas = document.createElement('canvas'); this.canvas.className = 'stage-flights'; this.canvas.setAttribute('aria-hidden', 'true'); document.body.append(this.canvas);
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new T.Scene(); this.scene.add(new T.AmbientLight(0xffffff, .7)); const l = new T.DirectionalLight(0xffffff, 1.6); l.position.set(.3, .6, 1); this.scene.add(l);
    // Page pixels map 1:1 onto the z=0 plane: x right, y down (flipped into the camera).
    this.camera = new T.OrthographicCamera(0, 1, 0, -1, -2000, 2000); this.resize();
    window.addEventListener('resize', () => this.resize());
    // Shared spark pool.
    this.max = 600; const pos = new Float32Array(this.max * 3), col = new Float32Array(this.max * 3);
    this.sparkGeo = new T.BufferGeometry(); this.sparkGeo.setAttribute('position', new T.BufferAttribute(pos, 3)); this.sparkGeo.setAttribute('color', new T.BufferAttribute(col, 3));
    this.sparks = []; this.points = new T.Points(this.sparkGeo, new T.PointsMaterial({ size: 7, map: glow(), vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: false }));
    this.points.frustumCulled = false; this.scene.add(this.points);
  }
  resize() { if (!this.renderer) return; const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h, false); Object.assign(this.camera, { left: 0, right: w, top: 0, bottom: -h }); this.camera.updateProjectionMatrix(); }
  token(kind) {
    const T = THREE, color = COLORS[kind] ?? COLORS.clone, g = new T.Group();
    const mat = new T.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .45, metalness: .55, roughness: .3 });
    if (kind === 'key') {
      const ring = new T.Mesh(new T.TorusGeometry(9, 3.2, 12, 28), mat); ring.position.x = -12;
      const shaft = new T.Mesh(new T.BoxGeometry(24, 4.4, 4.4), mat); shaft.position.x = 8;
      const t1 = new T.Mesh(new T.BoxGeometry(3.6, 7, 4.4), mat); t1.position.set(14, -4.5, 0); const t2 = t1.clone(); t2.position.x = 19;
      g.add(ring, shaft, t1, t2);
    } else if (kind === 'docker') {
      const box = new T.Mesh(new T.BoxGeometry(24, 24, 24), new T.MeshStandardMaterial({ color: 0x0f2236, emissive: color, emissiveIntensity: .25, metalness: .3, roughness: .4, transparent: true, opacity: .85 }));
      const edges = new T.LineSegments(new T.EdgesGeometry(box.geometry), new T.LineBasicMaterial({ color })); g.add(box, edges);
    } else if (kind === 'git') {
      const s = new T.Mesh(new T.IcosahedronGeometry(9, 2), mat); g.add(s);
      for (const i of [1, 2]) { const t = new T.Mesh(new T.IcosahedronGeometry(9 - i * 2.5, 1), mat); t.position.x = -i * 16; g.add(t); }
    } else if (kind === 'skill') g.add(new T.Mesh(new T.OctahedronGeometry(12, 0), mat));
    else { const card = new T.Mesh(new T.BoxGeometry(40, 26, 3), new T.MeshStandardMaterial({ color: 0x15201b, emissive: color, emissiveIntensity: .2, metalness: .2, roughness: .5 })); const edge = new T.LineSegments(new T.EdgesGeometry(card.geometry), new T.LineBasicMaterial({ color })); g.add(card, edge); }
    const h = new T.Sprite(new T.SpriteMaterial({ map: glow(), color, transparent: true, depthWrite: false, blending: T.AdditiveBlending })); h.scale.setScalar(90); h.position.z = -40; g.add(h);
    g.userData.color = new T.Color(color); return g;
  }
  spark(x, y, vx, vy, color, life) {
    if (this.sparks.length >= this.max) this.sparks.shift();
    this.sparks.push({ x, y, vx, vy, life, age: 0, c: color });
  }
  burst(x, y, color, n = 26, power = 260) { for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, v = power * (.35 + Math.random() * .65); this.spark(x, y, Math.cos(a) * v, Math.sin(a) * v, color, .55 + Math.random() * .4); } }
  ring(x, y, color) {
    const T = THREE, m = new T.Mesh(new T.RingGeometry(10, 13, 48), new T.MeshBasicMaterial({ color, transparent: true, opacity: .9, depthWrite: false, blending: T.AdditiveBlending }));
    m.position.set(x, -y, 0); this.scene.add(m); this.items.push({ kind: 'ring', mesh: m, age: 0, life: .7 });
  }
  add(item) { this.items.push(item); this.kick(); return item.done; }
  kick() { if (!this.frame) { this.prev = performance.now(); this.canvas.classList.add('on'); this.frame = requestAnimationFrame(t => this.tick(t)); } }
  tick(now) {
    this.frame = 0; const dt = Math.min(.05, (now - this.prev) / 1000); this.prev = now;
    for (const it of [...this.items]) {
      it.age += dt;
      if (it.kind === 'ring') { const k = it.age / it.life; it.mesh.scale.setScalar(1 + k * 5); it.mesh.material.opacity = .9 * (1 - k); if (k >= 1) { this.scene.remove(it.mesh); it.mesh.geometry.dispose(); this.items.splice(this.items.indexOf(it), 1); } continue; }
      if (it.age < it.delay) { it.obj.visible = false; continue; } it.obj.visible = true;
      const k = Math.min(1, (it.age - it.delay) / it.life), e = ease(k), { a, b, c } = it;
      const x = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * c.x + e * e * b.x, y = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * c.y + e * e * b.y;
      it.obj.position.set(x, -y, 40 * Math.sin(Math.PI * e));
      it.obj.rotation.x += dt * 2.2; it.obj.rotation.y += dt * 4.1;
      it.obj.scale.setScalar(it.scale * (.55 + Math.sin(Math.PI * e) * .9 + (k > .9 ? (1 - k) * 2 : 0)));
      if (Math.random() < .9) this.spark(x + (Math.random() - .5) * 10, y + (Math.random() - .5) * 10, (Math.random() - .5) * 40, (Math.random() - .5) * 40, it.obj.userData.color, .45);
      if (k >= 1) { this.scene.remove(it.obj); this.items.splice(this.items.indexOf(it), 1); this.burst(b.x, b.y, it.obj.userData.color); this.ring(b.x, b.y, it.obj.userData.color); it.resolve(); }
    }
    const pos = this.sparkGeo.attributes.position.array, col = this.sparkGeo.attributes.color.array;
    this.sparks = this.sparks.filter(s => (s.age += dt) < s.life);
    this.sparks.forEach((s, i) => { s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= .92; s.vy = s.vy * .92 + 30 * dt; const f = 1 - s.age / s.life; pos[i * 3] = s.x; pos[i * 3 + 1] = -s.y; pos[i * 3 + 2] = 10; col[i * 3] = s.c.r * f; col[i * 3 + 1] = s.c.g * f; col[i * 3 + 2] = s.c.b * f; });
    this.sparkGeo.setDrawRange(0, this.sparks.length); this.sparkGeo.attributes.position.needsUpdate = this.sparkGeo.attributes.color.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    if (this.items.length || this.sparks.length) this.frame = requestAnimationFrame(t => this.tick(t));
    else { this.renderer.clear(); this.canvas.classList.remove('on'); }
  }
}
const flights = new Flights();
const center = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const rectOf = x => x?.getBoundingClientRect ? x.getBoundingClientRect() : x;
// DOM fallback: a glowing dot that follows the same arc.
function domFlight(a, b, kind) {
  const dot = document.createElement('span'); dot.className = 'stage-dot'; dot.style.setProperty('--c', css(COLORS[kind] ?? COLORS.clone)); document.body.append(dot);
  const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 60 }, frames = [];
  for (let i = 0; i <= 12; i++) { const t = i / 12, x = (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y = (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y; frames.push({ transform: `translate(${x}px,${y}px) scale(${.6 + Math.sin(Math.PI * t)})` }); }
  return new Promise(resolve => { const anim = dot.animate(frames, { duration: 650, easing: 'ease-in-out' }); anim.onfinish = anim.oncancel = () => { dot.remove(); resolve(); }; });
}
// Fly a token of `kind` from one element (or rect) to another. Resolves when it lands. count > 1 sends a short stream.
export async function fly({ from, to, kind = 'clone', count = 1, scale = 1 }) {
  const A = rectOf(from), B = rectOf(to); if (!A || !B) return;
  const a = center(A), b = center(B);
  if (reduced()) return;
  if (!canWebgl()) return domFlight(a, b, kind);
  try { await load(); flights.init(); } catch { return domFlight(a, b, kind); }
  const dist = Math.hypot(b.x - a.x, b.y - a.y), c = { x: (a.x + b.x) / 2 + (b.y - a.y) * .12, y: Math.min(a.y, b.y) - Math.min(220, 60 + dist * .28) };
  const all = [];
  for (let i = 0; i < count; i++) {
    const obj = flights.token(kind); obj.visible = false; flights.scene.add(obj);
    let resolve; const done = new Promise(r => { resolve = r; });
    all.push(flights.add({ kind: 'flight', obj, a, b, c, age: 0, delay: i * .14, life: Math.min(1.25, .6 + dist / 1400), scale: scale * (i ? .7 : 1), resolve, done }));
  }
  await Promise.all(all);
}
// Sparks and a ring on an element: something arrived or finished there.
export async function burst(target, kind = 'clone') {
  if (reduced() || !canWebgl()) return;
  try { await load(); flights.init(); } catch { return; }
  const p = center(rectOf(target)), color = new THREE.Color(COLORS[kind] ?? COLORS.clone); flights.burst(p.x, p.y, color, 34, 300); flights.ring(p.x, p.y, color); flights.kick();
}
// Dockerize: container walls fly in from around an element, close into a cube and drop into the target.
export async function assemble({ around, into, kind = 'docker' }) {
  const A = rectOf(around), B = rectOf(into || around); if (!A) return;
  if (reduced()) return; if (!canWebgl()) return domFlight(center(A), center(B), kind);
  try { await load(); flights.init(); } catch { return; }
  const p = center(A), streams = [];
  for (let i = 0; i < 6; i++) { const ang = i / 6 * Math.PI * 2, r = Math.max(A.width, A.height) * .7 + 40; streams.push(fly({ from: { left: p.x + Math.cos(ang) * r, top: p.y + Math.sin(ang) * r, width: 0, height: 0 }, to: A, kind, scale: .5 })); }
  await Promise.all(streams); await fly({ from: A, to: B, kind, scale: 1.4 });
}
export function available() { return canWebgl() && !reduced(); }
// Classic scripts (app.js) reach the stage through window.OpayaStage.
window.OpayaStage = Object.freeze({ heroStage, fly, burst, assemble, available, preload: () => load().catch(() => null) });
window.dispatchEvent(new Event('opaya-stage'));
