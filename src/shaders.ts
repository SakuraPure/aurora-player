// 极简光影：一条白线 / 白色矩形音柱，极光色只出现在运动拖尾里，立体感只靠阴影。
// 着色器直接输出显示色（不做色彩空间转换）。

const common = /* glsl */ `
float sdBox(vec2 p, vec2 b){ vec2 q = abs(p) - b; return length(max(q, 0.)) + min(max(q.x, q.y), 0.); }
// 极光色：薄荷绿 → 蓝 → 紫 → 粉
vec3 aur(float s){
  s = clamp(s, 0., 1.);
  vec3 c = mix(vec3(0.22, 0.98, 0.80), vec3(0.26, 0.62, 1.00), smoothstep(0.00, 0.40, s));
  c = mix(c, vec3(0.62, 0.43, 1.00), smoothstep(0.35, 0.70, s));
  return mix(c, vec3(1.00, 0.46, 0.78), smoothstep(0.70, 1.00, s));
}
`

export const stageVert = /* glsl */ `
varying vec2 vW;
void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xy; gl_Position = projectionMatrix * viewMatrix * wp; }
`

// 数据纹理 N×2：
//   行0 = (音柱值, 音柱光晕, 波形值, 波形光晕)   —— 值以中线为基线，有正有负
//   行1 = (隐藏, 聚焦亮度, -, -)
export const stageFrag = /* glsl */ `
uniform sampler2D uD;
uniform float uN, uSlot, uX0, uRowW, uOffset, uMorph, uStage, uAmp, uGap, uTrail, uTime, uNear, uCursor;
uniform vec2 uShadow;
// 封面背景（开关）：cur = 当前封面（可做吸收/释放动画的矩形），prev = 换歌时淡出的上一张（固定在背景位）
uniform sampler2D uBgCur, uBgPrev;
uniform vec4 uBgRect, uBgFull; // 中心 xy + 半宽高（世界坐标）
uniform vec2 uView;            // 可视区半宽高
uniform vec2 uBgRest;          // 背景位的羽化与模糊（prev 层固定用它）
uniform vec3 uPal[4];          // 从封面取的拖尾渐变色（开关打开时替换默认极光色）
uniform float uPalMix;
uniform float uBgOn, uBgCurA, uBgPrevA, uBgAmb, uBgFeather, uBgLod, uBgK, uBgOp;
varying vec2 vW;
${common}
vec3 palC(float s){
  s = clamp(s, 0., 1.);
  vec3 c = mix(uPal[0], uPal[1], smoothstep(0.00, 0.40, s));
  c = mix(c, uPal[2], smoothstep(0.35, 0.70, s));
  return mix(c, uPal[3], smoothstep(0.70, 1.00, s));
}
// 高 mip 层 + 环形多点采样：便宜又平滑的大半径模糊
vec3 soft(sampler2D t, vec2 uv, float lod, float r){
  vec3 c = textureLod(t, uv, lod).rgb;
  for (int i = 0; i < 8; i++){ float a = float(i) * 0.7854 + 0.39; c += textureLod(t, uv + vec2(cos(a), sin(a)) * r, lod).rgb; }
  return c / 9.0;
}
// 封面以 cover 方式铺进矩形 R（窄矩形时裁切而不变形），边缘按 feather 羽化
vec4 coverLayer(sampler2D t, vec2 p, vec4 R, float feather, float lod){
  vec2 q = p - R.xy;
  vec2 uv = q / (2.0 * max(R.z, R.w)) + 0.5;
  vec2 e = R.zw - abs(q);
  float f = max(feather * min(R.z, R.w), 1e-4);
  float m = smoothstep(0.0, f, e.x) * smoothstep(0.0, f, e.y);
  return vec4(textureLod(t, clamp(uv, 0.0, 1.0), lod).rgb, m);
}
vec4 D(float k){ return texelFetch(uD, ivec2(int(mod(k, uN)), 0), 0); }
vec4 E(float k){ return texelFetch(uD, ivec2(int(mod(k, uN)), 1), 0); }
float cubic(float a, float b, float c, float d, float t){
  return b + 0.5 * t * (c - a + t * (2.*a - 5.*b + 4.*c - d + t * (3.*(b - c) + d - a)));
}
// 第 k 根音柱（从中线伸向 value 的矩形）的 SDF；lx 为相对柱中心的横向坐标
float barSdf(float k, float lx, float y){
  float v = D(k).r;
  float top = max(v, 0.0), bot = min(v, 0.0);
  float hh = max((top - bot) * 0.5, 0.012);
  return sdBox(vec2(lx, y - (top + bot) * 0.5), vec2(uSlot * 0.5 * (1.0 - uGap), hh)) + E(k).r * 10.0;
}
float rowMask(float xn){ return smoothstep(0.0, 0.015, xn) * smoothstep(1.0, 0.985, xn); }

void main(){
  float x = vW.x, y = vW.y;
  float px = fwidth(y);
  float xn = (x - uX0) / uRowW;
  float inRow = rowMask(xn);
  float u = (x - uX0 - uOffset) / uSlot;
  float m = uMorph;

  // 背景：近黑 + 一束很淡的舞台柔光（立体态略微提亮，让阴影可见）
  vec2 sp = vec2(x / (uRowW * 0.6), y / (uAmp * 2.4));
  vec3 col = vec3(0.036, 0.039, 0.048) + vec3(0.040, 0.043, 0.052) * exp(-dot(sp, sp)) * (0.35 + 0.65 * uStage);

  // 封面背景：远景 = 放大 + 重度模糊的色场；中景 = 清晰但半透明、边缘羽化的封面；近景 = 波形（在其前方压暗一条带保证层次）
  if (uBgOn > 0.001){
    vec2 p = vec2(x, y);
    vec2 uvA = (p - uBgFull.xy * 0.5) / (2.0 * max(uView.x, uView.y) * 1.3) + 0.5;
    vec3 amb = soft(uBgCur, uvA, 5.5, 0.05) * uBgAmb;
    if (uBgPrevA > 0.001) amb += soft(uBgPrev, uvA, 5.5, 0.05) * uBgPrevA;
    amb = mix(vec3(dot(amb, vec3(0.299, 0.587, 0.114))), amb, 0.8);
    col += amb * 0.3 * uBgOn;
    if (uBgPrevA > 0.001){
      vec4 pv = coverLayer(uBgPrev, p, uBgFull, uBgRest.x, uBgRest.y);
      col = mix(col, pv.rgb * 0.9, pv.a * uBgPrevA * uBgOp * uBgOn);
    }
    vec4 cv = coverLayer(uBgCur, p, uBgRect, uBgFeather, uBgLod);
    cv.rgb = mix(vec3(dot(cv.rgb, vec3(0.299, 0.587, 0.114))), cv.rgb, mix(0.88, 1.0, uBgK)); // 背景位略降饱和，让极光色更突出
    col = mix(col, cv.rgb * 0.9, cv.a * uBgCurA * uBgOn);
    float band = exp(-pow(y / (uAmp * 1.15), 2.0));
    col *= 1.0 - (0.26 * band + 0.3 * smoothstep(0.55, 1.25, length(p / uView))) * uBgOn * (1.0 - uBgK);
  }

  // 立体态：音柱投下柔和阴影
  if (uStage > 0.001){
    vec2 q = vec2(x, y) - uShadow * uStage;
    float us = (q.x - uX0 - uOffset) / uSlot, ks = floor(us);
    float ds = 1e3;
    for (int i = -1; i <= 1; i++){ float kk = ks + float(i); ds = min(ds, barSdf(kk, (us - kk - 0.5) * uSlot, q.y)); }
    float blur = 0.02 + 0.1 * uStage;
    col *= 1.0 - (1.0 - smoothstep(-blur, blur * 1.6, ds)) * 0.8 * uStage * rowMask((q.x - uX0) / uRowW);
  }

  // 平滑波形线
  float uc = u - 0.5, j = floor(uc), f = uc - j;
  vec4 a = D(j - 1.), b = D(j), c = D(j + 1.), d = D(j + 2.);
  float yl = cubic(a.b, b.b, c.b, d.b, f) * inRow;
  float hl = cubic(a.a, b.a, c.a, d.a, f) * inRow;
  float slope = dFdx(yl) / max(dFdx(x), 1e-6);
  float near = uNear * exp(-pow((x - uCursor) / (uRowW * 0.07), 2.0)); // 鼠标悬停处线条微微加粗
  float dLine = abs(y - yl) / sqrt(1.0 + slope * slope) - px * (0.9 + 0.9 * near);

  // 音柱
  float k = floor(u), lx = (u - k - 0.5) * uSlot;
  vec4 B = D(k), Ek = E(k);
  float dBar = barSdf(k, lx, y);

  // 线 → 柱：SDF 插值形变
  float dd = mix(dLine, dBar, m);
  float aa = px * 0.8; // dd 已是世界单位距离；不能用 fwidth(dd)：隐藏音柱的 SDF 在槽位边界跳变，会画出整列竖线
  float lineFade = smoothstep(-0.3, 0.02, xn) * smoothstep(1.3, 0.98, xn);
  float shape = smoothstep(aa, -aa, dd) * mix(lineFade, inRow, m);

  // 极光拖尾：从线/柱端延伸到滞后的"光晕"位置，光晕带惯性，停下时会冲过头
  float Lp = mix(yl, B.r, m), Hp = mix(hl, B.g, m);
  float gap = (Hp - Lp) * uTrail;
  float s = (y - Lp) / (abs(gap) > 1e-4 ? gap : 1e-4);
  float fall = clamp(1.0 - s, 0.0, 1.0);
  float strip = smoothstep(-0.03, 0.03, s) * pow(fall, 1.6);
  float hmask = mix(1.0, smoothstep(px, -px, abs(lx) - uSlot * 0.5 * (1.0 - uGap)) * (1.0 - Ek.r), m);
  float tA = strip * smoothstep(0.01, 0.14, abs(gap)) * hmask * mix(lineFade, inRow, m);
  float hs = xn * 0.9 + 0.05 + 0.08 * sin(uTime * 0.3);
  vec3 hue = aur(hs);
  if (uPalMix > 0.001) hue = mix(hue, palC(hs), uPalMix);
  vec3 tc = mix(hue, vec3(1.0), pow(fall, 8.0) * 0.4);

  col += tc * tA * 0.85;
  vec3 white = vec3(0.94, 0.95, 0.97) * mix(1.0, Ek.g, m);
  col = mix(col, mix(white, tc, tA * mix(0.25, 0.8, m)), shape);
  gl_FragColor = vec4(col, 1.0);
}
`

// ---------- 封面卡片：侧面是白色音柱，正面是封面 ----------
export const cardVert = /* glsl */ `
varying vec3 vN; varying vec3 vNW; varying vec2 vUv;
void main(){
  vN = normal; vNW = mat3(modelMatrix) * normal; vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`
export const cardFrag = /* glsl */ `
uniform sampler2D uTex;
uniform float uCover, uDim;
varying vec3 vN; varying vec3 vNW; varying vec2 vUv;
void main(){
  vec3 L = normalize(vec3(-0.45, 0.6, 1.0));
  float sh = 0.8 + 0.2 * max(dot(normalize(vNW), L), 0.0) / L.z;
  vec3 white = vec3(0.94, 0.95, 0.97) * sh;
  vec3 cov = texture2D(uTex, vUv).rgb * (0.94 + 0.06 * sh);
  vec3 c = mix(white, cov, uCover * step(0.5, vN.z)) * uDim;
  gl_FragColor = vec4(c, 1.0);
}
`

// ---------- 卡片投影 ----------
export const shadowVert = /* glsl */ `
uniform vec2 uExt; varying vec2 vP;
void main(){ vP = (uv - 0.5) * uExt; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }
`
export const shadowFrag = /* glsl */ `
uniform vec2 uHalf; uniform float uBlur, uAlpha; varying vec2 vP;
${common}
void main(){
  float d = sdBox(vP, uHalf);
  gl_FragColor = vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(-uBlur, uBlur * 1.6, d)) * uAlpha);
}
`
