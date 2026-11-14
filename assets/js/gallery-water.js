/* ==========================================================================
   かたわれ時 — 画廊的水面（Web Worker 里跑的 WebGL）
   第一次建 WebGL 上下文要在 GPU 进程里初始化设备，主线程上会同步卡 80–170ms（“图出来之前顿一下”）。
   所以画布交给这里（OffscreenCanvas）：建上下文、编译着色器、每一帧的绘制都在工作线程，主线程一次都不碰 WebGL。
   消息：init {canvas, bitmap, w, h, dpr, sy, docMax} · ripple {x, y, amp} · scroll {sy} · measure {docMax}
         resize {w, h, dpr} · active · pause {v}；回传 {type: "ready"} / {type: "fail"}
   ========================================================================== */
"use strict";
const FS = `precision mediump float;
varying vec2 v;
uniform sampler2D T; uniform vec2 R, I; uniform float t, drift; uniform vec4 rip[6];
float wave(vec2 p){
  float h = sin(dot(p, vec2(.84, .54)) * 6.5 + t * .50) * .55
          + sin(dot(p, vec2(-.48, .88)) * 10.5 - t * .66) * .32
          + sin(dot(p, vec2(.26, -.97)) * 18.0 + t * .97) * .16
          + sin(dot(p, vec2(.92, .39)) * 29.0 - t * 1.45) * .07;
  h *= .0016;
  for (int i = 0; i < 6; i++) {
    vec4 r = rip[i];
    if (r.w <= 0.) continue;
    float d = length(p - r.xy), w = d - r.z * .2;
    h += sin(w * 95.) * exp(-w * w / .0011) * exp(-r.z * 1.25) * r.w;
  }
  return h;
}
void main(){
  float ar = R.x / R.y;
  vec2 p = vec2(v.x * ar, v.y);
  float e = 1.5 / R.y;
  float h = wave(p);
  vec2 n = vec2(wave(p + vec2(e, 0.)) - h, wave(p + vec2(0., e)) - h) / e;
  vec2 s = vec2(1.);
  if (ar > I.x / I.y) s.y = (I.x / I.y) / ar; else s.x = ar / (I.x / I.y);
  s /= 1.12;
  vec2 uv = (v - .5) * s + .5;
  uv.y += (drift - .5) * (1. - s.y) * .9;
  uv += n * .55;
  vec3 c = texture2D(T, clamp(uv, .001, .999)).rgb;
  float lum = dot(c, vec3(.3, .55, .15));
  vec3 N = normalize(vec3(-n * 9., 1.));
  float sp = pow(max(dot(N, normalize(vec3(.32, .5, 1.))), 0.), 70.);
  c += vec3(1., .97, .9) * sp * smoothstep(.28, .8, lum) * .55;
  c *= .80 + .06 * smoothstep(.2, .9, lum);
  gl_FragColor = vec4(c, 1.);
}`;
const VS = "attribute vec2 p; varying vec2 v; void main(){ v = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }";
const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

let canvas, gl, U, W = 1, H = 1, DPR = 1, q = 0.6, sy = 0, docMax = 1;
let paused = false, pending = 0, last = 0, active = 0, odd = false, slow = 0, dtAvg = 16, ri = 0, ready = false;
const rips = new Float32Array(24), t0 = performance.now();

function size() {
  const d = Math.min(DPR, 2) * q;
  canvas.width = Math.max(2, Math.round(W * d)); canvas.height = Math.max(2, Math.round(H * d));
  if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
}
function kick() { if (ready && !pending && !paused) pending = raf(frame); }
function poke() { active = performance.now(); kick(); }
function frame(now) {
  pending = 0;
  if (paused) return;
  pending = raf(frame);
  const live = rips[3] > 0 || rips[7] > 0 || rips[11] > 0 || rips[15] > 0 || rips[19] > 0 || rips[23] > 0;
  odd = !odd;
  if (!live && now - active > 2500 && odd) return;          // 空闲时隔帧绘制：水流很慢，半帧率看不出
  const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
  dtAvg += (dt * 1000 - dtAvg) * 0.05;
  if (dtAvg > 26 && q > 0.36 && (live || now - active <= 2500)) { if (++slow > 40) { q *= 0.8; slow = 0; size(); } } else slow = 0;
  for (let k = 0; k < 6; k++) if (rips[k * 4 + 3] > 0) { rips[k * 4 + 2] += dt; if (rips[k * 4 + 2] > 4) rips[k * 4 + 3] = 0; }
  gl.uniform2f(U.R, canvas.width, canvas.height);
  gl.uniform1f(U.t, (now - t0) / 1000);
  gl.uniform1f(U.drift, clamp(sy / docMax, 0, 1));
  gl.uniform4fv(U.rip, rips);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

async function init(m) {
  canvas = m.canvas; W = m.w; H = m.h; DPR = m.dpr; sy = m.sy; docMax = m.docMax;
  size();                                                    // 先定尺寸再建上下文
  gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "low-power" });
  if (!gl) throw new Error("no webgl");
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  U = {}; ["T", "R", "I", "t", "drift", "rip"].forEach((k) => (U[k] = gl.getUniformLocation(prog, k === "rip" ? "rip[0]" : k)));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, m.bitmap);
  gl.uniform1i(U.T, 0); gl.uniform2f(U.I, m.bitmap.width, m.bitmap.height);
  if (m.bitmap.close) m.bitmap.close();
  ready = true; active = performance.now();
  frame(performance.now());                                  // 先画一帧（着色器的真正编译也在这一下，但不在主线程）
  postMessage({ type: "ready" });
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case "init": init(m).catch((err) => postMessage({ type: "fail", msg: String(err && err.message) })); break;
    case "ripple": {
      const o = (ri++ % 6) * 4;
      rips[o] = (m.x / W) * (W / H); rips[o + 1] = 1 - m.y / H; rips[o + 2] = 0; rips[o + 3] = m.amp;
      poke(); break;
    }
    case "scroll": sy = m.sy; poke(); break;
    case "measure": docMax = Math.max(1, m.docMax); break;
    case "resize": W = m.w; H = m.h; DPR = m.dpr; if (canvas) size(); poke(); break;
    case "active": poke(); break;
    case "pause": paused = !!m.v; if (!paused) { last = 0; poke(); } break;
  }
};
