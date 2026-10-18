import { useEffect, useMemo, useRef, useState } from "react";
import {
  Home, PlusCircle, History, Settings, Sun, Moon, Trash2, Minus, Plus,
  Mic, Loader2, Eye, EyeOff, User, Check, Flame,
} from "lucide-react";

/* ---------- Sabitler ---------- */
const GOAL_MIN = 800;
const GOAL_MAX = 6000;
const DEFAULT_SETTINGS = { goal: 2100, split: { p: 25, c: 45, f: 30 } };
const DEFAULT_MODEL = "gemini-2.5-flash";
const MACROS = [
  { key: "p", label: "Protein", kcalPerG: 4, color: "var(--p)" },
  { key: "c", label: "Karbonhidrat", kcalPerG: 4, color: "var(--c)" },
  { key: "f", label: "Yağ", kcalPerG: 9, color: "var(--f)" },
];
const MEAL_TYPES = ["Kahvaltı", "Öğle", "Akşam", "Atıştırmalık"];
const TABS = [
  { id: "home", label: "Ana Sayfa", Icon: Home },
  { id: "add", label: "Öğün Ekle", Icon: PlusCircle },
  { id: "history", label: "Geçmiş", Icon: History },
  { id: "profile", label: "Profil", Icon: User },
  { id: "settings", label: "Ayarlar", Icon: Settings },
];

const theme = `
.caloroid{--bg:#F1F3F9;--surface:#FFFFFF;--ink:#151A2D;--muted:#6B7290;--line:#E1E5F0;--accent:#E8890C;--accent-ink:#FFFFFF;--over:#D6366B;--track:#ECEFF7;--p:#5B6CF2;--c:#E8890C;--f:#1FA98B}
.caloroid[data-theme="dark"]{--bg:#0D0F1E;--surface:#171A31;--ink:#EDEFFA;--muted:#9097B8;--line:#252A48;--accent:#FFB547;--accent-ink:#1B1303;--over:#FF6B9A;--track:#222744;--p:#8C9BFF;--c:#FFB547;--f:#4FD1B0}
.cal-voice{--lvl:0}
@keyframes cal-breathe{0%,100%{transform:scale(1);opacity:.25}50%{transform:scale(1.12);opacity:.5}}
.cal-breathe{animation:cal-breathe 2.6s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.cal-breathe{animation:none}}
`;

/* ---------- Yardımcılar ---------- */
const fmt = (n) => n.toLocaleString("tr-TR");
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const dateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// localStorage her ortamda çalışmayabilir (gizli mod, kota, iframe); okuma ve yazma güvenli sarılı.
const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* depolama kullanılamıyor: uygulama bellekte çalışmaya devam eder */
  }
};
const KEYS = { days: "caloroid:v1", theme: "caloroid:theme", settings: "caloroid:settings", gemini: "caloroid:gemini", profile: "caloroid:profile" };

const loadDays = () => {
  const raw = read(KEYS.days);
  return raw && typeof raw.days === "object" && raw.days ? raw.days : {};
};
const loadSettings = () => {
  const s = read(KEYS.settings);
  const ok =
    s && Number.isFinite(s.goal) && s.goal >= GOAL_MIN && s.goal <= GOAL_MAX &&
    s.split && ["p", "c", "f"].every((k) => Number.isFinite(s.split[k])) &&
    s.split.p + s.split.c + s.split.f === 100;
  return ok ? s : DEFAULT_SETTINGS;
};
// API anahtarı ayrı tutulur: "Varsayılana dön" anahtarı silmez.
const loadGemini = () => {
  const g = read(KEYS.gemini);
  return {
    key: g && typeof g.key === "string" ? g.key : "",
    model: g && typeof g.model === "string" && g.model ? g.model : DEFAULT_MODEL,
  };
};
const loadDark = () => {
  try {
    const t = localStorage.getItem(KEYS.theme);
    if (t) return t.replace(/"/g, "") === "dark";
  } catch {
    /* yoksay */
  }
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
};

// Kalori hedefi ve yüzdelerden gram hedefleri (protein/karb 4 kcal, yağ 9 kcal)
const macroGoals = ({ goal, split }) =>
  Object.fromEntries(MACROS.map((m) => [m.key, Math.round((goal * split[m.key]) / 100 / m.kcalPerG)]));

// Bir yüzdeyi değiştirince kalan payı diğer ikisine orantılı dağıtır; toplam hep 100 kalır.
function rebalance(split, key, value) {
  const val = clamp(Math.round(value), 0, 100);
  const [a, b] = ["p", "c", "f"].filter((k) => k !== key);
  const rest = 100 - val;
  const sumOthers = split[a] + split[b];
  const na = sumOthers > 0 ? Math.round((rest * split[a]) / sumOthers) : Math.round(rest / 2);
  return { ...split, [key]: val, [a]: na, [b]: rest - na };
}

const sumMeals = (meals) =>
  meals.reduce(
    (t, m) => ({ kcal: t.kcal + m.kcal, p: t.p + m.p, c: t.c + m.c, f: t.f + m.f }),
    { kcal: 0, p: 0, c: 0, f: 0 }
  );

/* Makro mantığı:
   - Makrolar girildiyse olduğu gibi kullanılır; kalori boşsa 4P + 4K + 9Y ile hesaplanır.
   - Sadece kalori girildiyse makrolar kullanıcının Ayarlar'daki yüzdeleriyle tahmin edilir. */
function resolveMeal({ kcal, p, c, f }, split) {
  const K = Number(kcal) || 0, P = Number(p) || 0, C = Number(c) || 0, F = Number(f) || 0;
  if (P || C || F) return { kcal: K || Math.round(4 * P + 4 * C + 9 * F), p: P, c: C, f: F, est: false, kcalFromMacros: !K };
  if (K > 0)
    return {
      kcal: K,
      p: Math.round((K * split.p) / 100 / 4),
      c: Math.round((K * split.c) / 100 / 4),
      f: Math.round((K * split.f) / 100 / 9),
      est: true,
    };
  return null;
}

/* ---------- Gemini ---------- */
const SYSTEM_PROMPT =
  "Sen bir beslenme asistanısın. Kullanıcı bir öğünde ne yediğini Türkçe anlatır. " +
  "Metindeki tüm yiyecek ve içecekleri tek bir öğün olarak topla. Porsiyon belirtilmemişse Türk mutfağında yaygın, makul porsiyonlar varsay. " +
  "Toplam kaloriyi (kcal) ve protein, karbonhidrat, yağı gram olarak tahmin et. " +
  "name: öğünü özetleyen kısa Türkçe başlık. type: öğünün türü (söylenmediyse saate ve yemeğe göre en uygun olanı seç). " +
  "assumption: varsaydığın porsiyonları tek kısa cümleyle yaz. Metin yemekle ilgili değilse kcal değerini 0 yap. Yalnızca JSON döndür.";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    type: { type: "STRING", enum: MEAL_TYPES },
    kcal: { type: "NUMBER" },
    protein: { type: "NUMBER" },
    carbs: { type: "NUMBER" },
    fat: { type: "NUMBER" },
    assumption: { type: "STRING" },
  },
  required: ["name", "type", "kcal", "protein", "carbs", "fat", "assumption"],
};

async function estimateWithGemini(text, { key, model }) {
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      // Anahtar URL yerine başlıkta gönderilir; adres günlüklerinde görünmez.
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
      }),
    });
  } catch {
    throw new Error("Bağlantı kurulamadı. İnternetini kontrol edip tekrar dene.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    const msg = err?.error?.message || "";
    if (res.status === 400 && /api key/i.test(msg)) throw new Error("API anahtarı geçersiz. Ayarlar'dan kontrol et.");
    if (res.status === 401 || res.status === 403) throw new Error("API anahtarının bu isteğe izni yok. Anahtarı ve kısıtlamalarını kontrol et.");
    if (res.status === 404) throw new Error(`“${model}” modeli bulunamadı. Ayarlar'dan model adını kontrol et.`);
    if (res.status === 429) throw new Error("İstek sınırına ulaşıldı. Biraz bekleyip tekrar dene.");
    throw new Error(msg || `Gemini isteği başarısız oldu (${res.status}).`);
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  let out;
  try {
    out = JSON.parse(String(raw).replace(/```json|```/g, "").trim());
  } catch {
    throw new Error("Yanıt anlaşılamadı. Cümleyi biraz daha açık yazıp tekrar dene.");
  }
  const num = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.round(Number(x))) : 0);
  const meal = { name: String(out.name || "").trim(), type: out.type, kcal: num(out.kcal), p: num(out.protein), c: num(out.carbs), f: num(out.fat), note: String(out.assumption || "").trim() };
  if (!meal.kcal) throw new Error("Bu cümleden bir öğün çıkaramadım. Ne yediğini biraz daha ayrıntılı anlat.");
  return meal;
}

/* ---------- Ses tanıma ---------- */
const SpeechRec = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const speechError = (code) =>
  ({
    "not-allowed": "Mikrofon izni verilmedi. Tarayıcı ayarlarından izin ver.",
    "service-not-allowed": "Mikrofon izni verilmedi. Tarayıcı ayarlarından izin ver.",
    "no-speech": "Ses algılanmadı. Tekrar dene.",
    "audio-capture": "Mikrofon bulunamadı.",
    network: "Ses tanıma için internet bağlantısı gerekli.",
  })[code] || "Ses tanıma başarısız oldu. Tekrar dene ya da metni yaz.";

/* ---------- Ana Sayfa ---------- */
function CalorieRing({ eaten, goal }) {
  const r = 70;
  const circ = 2 * Math.PI * r;
  const ratio = Math.min(eaten / goal, 1);
  const over = eaten > goal;
  return (
    <svg viewBox="0 0 180 180" className="h-44 w-44 shrink-0 -rotate-90" role="img"
      aria-label={`${fmt(eaten)} / ${fmt(goal)} kcal`}>
      <circle cx="90" cy="90" r={r} fill="none" stroke="var(--track)" strokeWidth="14" />
      <circle cx="90" cy="90" r={r} fill="none" strokeWidth="14" strokeLinecap="round"
        stroke={over ? "var(--over)" : "var(--accent)"}
        strokeDasharray={circ} strokeDashoffset={circ * (1 - ratio)}
        style={{ transition: "stroke-dashoffset .6s ease" }} />
    </svg>
  );
}

function Dashboard({ eaten, goal }) {
  const left = goal - eaten;
  return (
    <section className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-5">
      <div className="flex items-center gap-5">
        <div className="relative">
          <CalorieRing eaten={eaten} goal={goal} />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-bold tabular-nums tracking-tight">{fmt(eaten)}</span>
            <span className="text-xs text-[var(--muted)]">kcal alındı</span>
          </div>
        </div>
        <dl className="min-w-0 flex-1 space-y-3">
          <div>
            <dt className="text-xs text-[var(--muted)]">Günlük hedef</dt>
            <dd className="text-lg font-semibold tabular-nums">{fmt(goal)} kcal</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">{left >= 0 ? "Kalan" : "Hedef aşıldı"}</dt>
            <dd className={`text-lg font-semibold tabular-nums ${left < 0 ? "text-[var(--over)]" : ""}`}>
              {fmt(Math.abs(left))} kcal
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function MacroCards({ totals, goals }) {
  return (
    <section aria-label="Günlük makrolar" className="grid grid-cols-3 gap-3">
      {MACROS.map((m) => {
        const value = totals[m.key];
        const goal = goals[m.key];
        const pct = goal > 0 ? Math.min((value / goal) * 100, 100) : 0;
        return (
          <div key={m.key} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3">
            <p className="truncate text-xs text-[var(--muted)]">{m.label}</p>
            <p className="mt-1 text-base font-semibold tabular-nums">
              {fmt(value)}
              <span className="text-xs font-normal text-[var(--muted)]"> / {goal} g</span>
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--track)]" role="progressbar"
              aria-label={m.label} aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(value, goal)}>
              <div className="h-full rounded-full"
                style={{ width: `${pct}%`, background: m.color, transition: "width .5s ease" }} />
            </div>
          </div>
        );
      })}
    </section>
  );
}

function HomeTab({ meals, totals, settings, onDelete }) {
  return (
    <div className="space-y-5">
      <Dashboard eaten={totals.kcal} goal={settings.goal} />
      <MacroCards totals={totals} goals={macroGoals(settings)} />
      <section>
        <h2 className="mb-3 text-base font-semibold">Bugünkü öğünler</h2>
        {meals.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-sm text-[var(--muted)]">
            Henüz öğün eklemedin. “Öğün Ekle” sekmesinden ilk öğününü kaydet.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
            {meals.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{m.name}</p>
                  <p className="text-xs text-[var(--muted)]">
                    {m.type} · {m.est ? "~" : ""}P {m.p}g {m.est ? "~" : ""}K {m.c}g {m.est ? "~" : ""}Y {m.f}g
                  </p>
                </div>
                <span className="font-semibold tabular-nums">{fmt(m.kcal)} kcal</span>
                <button onClick={() => onDelete(m.id)} aria-label={`${m.name} öğününü sil`}
                  className="rounded-full p-2 text-[var(--muted)] hover:text-[var(--over)]">
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------- Öğün Ekle ---------- */
const inputCls =
  "w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] px-4 py-3 text-base outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

const IOS = typeof navigator !== "undefined" && /iP(hone|ad|od)/.test(navigator.userAgent);
const cap = (s) => s.charAt(0).toLocaleUpperCase("tr-TR") + s.slice(1);

function VoiceMic({ gemini, onResult, onGoSettings }) {
  const [phase, setPhase] = useState("idle"); // idle | listening | processing
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const recRef = useRef(null);
  const textRef = useRef("");
  const cancelRef = useRef(false);
  const failedRef = useRef(false);
  const activeRef = useRef(false);
  const overlayRef = useRef(null);
  const micRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const bumpRef = useRef(0);
  const hasKey = gemini.key.trim().length > 0;

  const stopAudio = () => {
    cancelAnimationFrame(rafRef.current);
    const a = audioRef.current;
    if (a) {
      a.stream.getTracks().forEach((t) => t.stop());
      a.ctx.close().catch(() => {});
      audioRef.current = null;
    }
    overlayRef.current?.style.setProperty("--lvl", "0");
  };

  // Konuşma şiddeti: mikrofon seviyesi ölçülür. Ölçülemezse (ör. iOS) her yeni kelimede halka bir kez titrer.
  const startMeter = async () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let analyser = null;
    let buf = null;
    if (!IOS && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!activeRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        ctx.resume?.().catch(() => {});
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        buf = new Uint8Array(analyser.fftSize);
        audioRef.current = { stream, ctx };
      } catch {
        analyser = null;
      }
    }
    let level = 0;
    const tick = () => {
      let raw;
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const x = (buf[i] - 128) / 128;
          sum += x * x;
        }
        raw = clamp(Math.sqrt(sum / buf.length) * 6, 0, 1);
      } else {
        raw = bumpRef.current;
        bumpRef.current *= 0.9;
      }
      level = raw > level ? level * 0.4 + raw * 0.6 : level * 0.88 + raw * 0.12;
      overlayRef.current?.style.setProperty("--lvl", level.toFixed(3));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  // Metni forma aktarır: Gemini anahtarı varsa kalori ve makrolar da tahmin edilir.
  const handleTranscript = async (t) => {
    setPhase("processing");
    const fallback = { name: cap(t) };
    if (!hasKey) {
      onResult(fallback);
      setNote("Gemini anahtarı olmadığı için yalnızca açıklamayı aktardım. Kalori ve makroları elle girebilirsin.");
      setPhase("idle");
      return;
    }
    try {
      const meal = await estimateWithGemini(t, gemini);
      onResult(meal);
      setNote(meal.note ? `Varsayım: ${meal.note} Değerleri aşağıda düzenleyebilirsin.` : "Değerleri aşağıda düzenleyebilirsin.");
    } catch (e) {
      onResult(fallback); // söylediklerin kaybolmasın
      setError(e.message);
    }
    setPhase("idle");
  };

  const start = () => {
    if (!SpeechRec) return;
    setError("");
    setNote("");
    setText("");
    textRef.current = "";
    cancelRef.current = false;
    failedRef.current = false;
    bumpRef.current = 0;
    const rec = new SpeechRec();
    rec.lang = "tr-TR";
    rec.interimResults = true;
    rec.continuous = false; // susunca tarayıcı kendiliğinden durdurur
    rec.onresult = (e) => {
      const t = Array.from(e.results, (r) => r[0].transcript).join(" ").trim();
      textRef.current = t;
      setText(t);
      bumpRef.current = 0.7;
    };
    rec.onerror = (e) => {
      if (e.error === "aborted") return;
      failedRef.current = true;
      setError(speechError(e.error));
    };
    rec.onend = () => {
      activeRef.current = false;
      stopAudio();
      const t = textRef.current;
      if (cancelRef.current || failedRef.current) return setPhase("idle");
      if (!t) {
        setError(speechError("no-speech"));
        return setPhase("idle");
      }
      handleTranscript(t);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      setError(speechError());
      return;
    }
    activeRef.current = true;
    setPhase("listening");
    startMeter();
  };

  const toggle = () => {
    if (phase === "listening") recRef.current?.stop(); // son sonucu verip biter
    else if (phase === "idle") start();
  };
  const cancel = () => {
    cancelRef.current = true;
    recRef.current?.abort();
  };

  useEffect(() => () => {
    cancelRef.current = true;
    recRef.current?.abort();
    stopAudio();
  }, []);

  useEffect(() => {
    if (phase !== "listening") return;
    micRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  useEffect(() => {
    if (phase === "idle") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [phase]);

  const open = phase !== "idle";
  const ring = (size, style, cls = "") => (
    <span aria-hidden="true" className={`absolute left-1/2 top-1/2 rounded-full ${cls}`}
      style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, ...style }} />
  );

  return (
    <>
      <section className="flex flex-col items-center text-center">
        <button onClick={toggle} disabled={!SpeechRec || open} aria-label="Sesle öğün ekle"
          className="grid h-28 w-28 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] transition-transform active:scale-95 disabled:opacity-40"
          style={{ boxShadow: "0 12px 32px -10px var(--accent)" }}>
          <Mic size={44} strokeWidth={1.8} />
        </button>
        <p className="mt-4 text-sm font-medium">
          {SpeechRec ? "Dokun ve ne yediğini anlat" : "Ses tanıma bu tarayıcıda desteklenmiyor"}
        </p>
        <p className="mt-1 max-w-xs text-xs text-[var(--muted)]">
          {SpeechRec ? "Örn: “Öğle yemeğinde 1 tabak mantı ve ayran içtim”" : "Öğünü aşağıdan elle girebilirsin."}
        </p>
        <div className="mt-3 space-y-1 text-sm" aria-live="polite">
          {error && <p className="text-[var(--over)]">{error}</p>}
          {note && <p className="max-w-xs text-[var(--muted)]">{note}</p>}
          {SpeechRec && !hasKey && (
            <p className="text-xs text-[var(--muted)]">
              Kalori tahmini için{" "}
              <button onClick={onGoSettings} className="font-medium text-[var(--accent)] underline">Gemini anahtarı ekle</button>
            </p>
          )}
          {SpeechRec && hasKey && !error && !note && (
            <p className="text-xs text-[var(--muted)]">Söylediklerin Google'ın Gemini servisine gönderilir.</p>
          )}
        </div>
      </section>

      {/* Dinleme katmanı */}
      <div ref={overlayRef} role="dialog" aria-modal="true" aria-label="Sesli öğün girişi" aria-hidden={!open}
        className={`cal-voice fixed inset-0 z-50 transition-opacity duration-300 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        style={{ background: "rgba(7, 9, 22, 0.82)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}>
        <div className="mx-auto flex h-full w-full max-w-md flex-col px-6"
          style={{ paddingTop: "max(1.5rem, env(safe-area-inset-top))", paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
          <div className="min-h-[8rem]" aria-live="polite">
            <p className="text-xs text-white/60">{phase === "processing" ? "Kalorileri hesaplıyorum…" : "Dinliyorum"}</p>
            <p className={`mt-2 text-2xl font-semibold leading-snug transition-colors ${text ? "text-white" : "text-white/40"}`}>
              {text || "Ne yediğini söyle…"}
            </p>
          </div>

          <div className="relative flex flex-1 items-center justify-center">
            <div className="relative h-32 w-32 transition-transform duration-500 ease-out"
              style={{ transform: open ? "scale(1)" : "scale(0.85)" }}>
              <div className="transition-opacity duration-300" style={{ opacity: phase === "listening" ? 1 : 0 }}>
                {ring(176, { border: "1px solid var(--accent)" }, "cal-breathe")}
                {ring(160, { border: "2px solid var(--accent)", opacity: 0.55, transform: "scale(calc(1 + var(--lvl) * 0.5))", transition: "transform 90ms linear" })}
                {ring(144, { background: "var(--accent)", opacity: 0.16, transform: "scale(calc(1 + var(--lvl) * 1.1))", transition: "transform 110ms linear" })}
              </div>
              <button ref={micRef} onClick={toggle} disabled={phase === "processing"}
                aria-label={phase === "listening" ? "Dinlemeyi bitir" : "Hesaplanıyor"}
                className="absolute inset-0 grid place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)]"
                style={{ boxShadow: "0 16px 40px -12px var(--accent)" }}>
                {phase === "processing" ? <Loader2 size={44} className="animate-spin" /> : <Mic size={48} strokeWidth={1.8} />}
              </button>
            </div>
          </div>

          <div className="flex min-h-[5rem] flex-col items-center gap-3">
            {phase === "listening" && (
              <>
                <p className="text-center text-xs text-white/60">Bitirmek için mikrofona dokun. Sustuğunda kendiliğinden durur.</p>
                <button onClick={cancel} className="rounded-full border border-white/20 px-5 py-2.5 text-sm text-white/80">
                  İptal
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function AddTab({ split, gemini, onAdd, onGoSettings }) {
  const [type, setType] = useState(MEAL_TYPES[0]);
  const [name, setName] = useState("");
  const [v, setV] = useState({ kcal: "", p: "", c: "", f: "" });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value.replace(/\D/g, "") }));

  const fromAi = (m) => {
    if (MEAL_TYPES.includes(m.type)) setType(m.type);
    setName(m.name);
    if (m.kcal) setV({ kcal: String(m.kcal), p: String(m.p), c: String(m.c), f: String(m.f) });
  };

  const resolved = resolveMeal(v, split);
  const valid = name.trim() && resolved && resolved.kcal > 0;

  let hint = "Sadece kalori girersen makrolar Ayarlar'daki dağılıma göre tahmin edilir. Makro girersen kalori hesaplanır.";
  if (resolved?.est) hint = `Tahmini makrolar: Protein ${resolved.p} g, Karbonhidrat ${resolved.c} g, Yağ ${resolved.f} g.`;
  else if (resolved?.kcalFromMacros) hint = `Makrolardan hesaplanan kalori: ${resolved.kcal} kcal.`;

  return (
    <div className="space-y-5">
      <VoiceMic gemini={gemini} onResult={fromAi} onGoSettings={onGoSettings} />

      <h2 className="text-base font-semibold">Öğün bilgileri</h2>
      <div className="flex flex-wrap gap-2">
        {MEAL_TYPES.map((t) => (
          <button key={t} onClick={() => setType(t)} aria-pressed={type === t}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
              type === t
                ? "border-transparent bg-[var(--accent)] text-[var(--accent-ink)]"
                : "border-[var(--line)] bg-[var(--surface)] text-[var(--muted)]"
            }`}>
            {t}
          </button>
        ))}
      </div>
      <input className={inputCls} placeholder="Ne yedin?" value={name}
        onChange={(e) => setName(e.target.value)} aria-label="Yemek adı" />
      <input className={inputCls} placeholder="Kalori (kcal)" inputMode="numeric" value={v.kcal}
        onChange={set("kcal")} aria-label="Kalori" />
      <div className="grid grid-cols-3 gap-3">
        {MACROS.map((m) => (
          <label key={m.key} className="block text-xs text-[var(--muted)]">
            {m.label} (g)
            <input className={`${inputCls} mt-1`} placeholder="0" inputMode="numeric" value={v[m.key]}
              onChange={set(m.key)} />
          </label>
        ))}
      </div>
      <p className="text-sm text-[var(--muted)]" aria-live="polite">{hint}</p>
      <button disabled={!valid}
        onClick={() => {
          onAdd({ id: Date.now(), type, name: name.trim(), kcal: resolved.kcal, p: resolved.p, c: resolved.c, f: resolved.f, est: resolved.est });
          setName("");
          setV({ kcal: "", p: "", c: "", f: "" });
        }}
        className="w-full rounded-xl bg-[var(--accent)] py-3.5 font-semibold text-[var(--accent-ink)] transition-opacity disabled:opacity-40">
        Öğünü kaydet
      </button>
    </div>
  );
}

/* ---------- Geçmiş ---------- */
function HistoryTab({ days, settings, onGoAdd }) {
  const [view, setView] = useState("records");
  return (
    <div className="space-y-5">
      <Segmented label="Görünüm" value={view} onChange={setView}
        options={[{ value: "records", label: "Kayıtlar" }, { value: "stats", label: "İstatistikler" }]} />
      {view === "records" ? <RecordsView days={days} goal={settings.goal} /> : <StatsTab days={days} settings={settings} onGoAdd={onGoAdd} />}
    </div>
  );
}


function RecordsView({ days, goal }) {
  const rows = useMemo(() => {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const kcal = sumMeals(days[dateKey(d)] || []).kcal;
      out.push({ key: dateKey(d), label: i === 0 ? "Bugün" : d.toLocaleDateString("tr-TR", { weekday: "short" }), kcal });
    }
    return out;
  }, [days]);

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Son 7 gün</h2>
      <ul className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
        {rows.map((d) => {
          const w = Math.min((d.kcal / (goal * 1.25)) * 100, 100);
          const over = d.kcal > goal;
          return (
            <li key={d.key} className="flex items-center gap-3 text-sm">
              <span className="w-11 text-[var(--muted)]">{d.label}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--track)]">
                <div className="h-full rounded-full"
                  style={{ width: `${w}%`, background: over ? "var(--over)" : "var(--accent)" }} />
              </div>
              <span className="w-16 text-right font-medium tabular-nums">{d.kcal ? fmt(d.kcal) : "—"}</span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-[var(--muted)]">Çubuklar güncel hedefin ({fmt(goal)} kcal) üzerinden hesaplanır. Aşılan günler pembe görünür.</p>
    </div>
  );
}

/* ---------- İstatistikler ---------- */
const TOLERANCE = 0.1; // Hedefin ±%10'u içindeki günler "hedefte" sayılır
const dayStatus = (kcal, goal) =>
  kcal === 0 ? "none" : kcal > goal * (1 + TOLERANCE) ? "over" : kcal >= goal * (1 - TOLERANCE) ? "hit" : "under";
const STATUS_TEXT = { none: "Kayıt yok", under: "Hedefin altında", hit: "Hedef aralığında", over: "Hedefin üzerinde" };
const STATUS_COLOR = {
  none: "var(--track)",
  under: "color-mix(in srgb, var(--accent) 30%, var(--track))",
  hit: "var(--accent)",
  over: "var(--over)",
};
const parseKey = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};

function computeStats(days, goal) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dateKey(today);
  const totalsOf = (d) => sumMeals(days[dateKey(d)] || []);

  // Son 7 gün
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const t = totalsOf(d);
    week.push({
      key: dateKey(d),
      label: i === 0 ? "Bugün" : d.toLocaleDateString("tr-TR", { weekday: "short" }),
      ...t,
      status: dayStatus(t.kcal, goal),
    });
  }
  const logged = week.filter((d) => d.kcal > 0);
  const n = logged.length;
  const sum = logged.reduce((t, d) => ({ kcal: t.kcal + d.kcal, p: t.p + d.p, c: t.c + d.c, f: t.f + d.f }), { kcal: 0, p: 0, c: 0, f: 0 });
  const avg = n ? Math.round(sum.kcal / n) : 0;
  const macroAvg = { p: n ? Math.round(sum.p / n) : 0, c: n ? Math.round(sum.c / n) : 0, f: n ? Math.round(sum.f / n) : 0 };

  // Kalorinin makrolara payı (protein ve karbonhidrat 4, yağ 9 kcal/g)
  const kc = { p: sum.p * 4, c: sum.c * 4, f: sum.f * 9 };
  const total = kc.p + kc.c + kc.f;
  let share = { p: 0, c: 0, f: 0 };
  if (total > 0) {
    const p = Math.round((kc.p / total) * 100);
    const c = Math.round((kc.c / total) * 100);
    share = { p, c, f: Math.max(0, 100 - p - c) };
  }

  // Seri: tüm geçmişi gün gün tara. Bugün henüz tamamlanmadıysa seriyi bozmaz; hedefi aşarsa bozar.
  const keys = Object.keys(days).filter((k) => days[k]?.length).sort();
  let run = 0;
  let best = 0;
  if (keys.length) {
    for (const d = parseKey(keys[0]); dateKey(d) <= todayKey; d.setDate(d.getDate() + 1)) {
      const st = dayStatus(totalsOf(d).kcal, goal);
      if (st === "hit") {
        run++;
        best = Math.max(best, run);
      } else if (dateKey(d) === todayKey && st !== "over") {
        /* bugün devam ediyor */
      } else {
        run = 0;
      }
    }
  }

  return { week, logged: n, avg, macroAvg, share, hits7: week.filter((d) => d.status === "hit").length, streak: run, best };
}

function SplitBar({ split }) {
  return (
    <div className="flex h-3 overflow-hidden rounded-full bg-[var(--track)]" aria-hidden="true">
      {MACROS.map((m) => (
        <div key={m.key} style={{ width: `${split[m.key]}%`, background: m.color, transition: "width .4s ease" }} />
      ))}
    </div>
  );
}

const cardCls = "rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-5";

function StatsTab({ days, settings, onGoAdd }) {
  const { goal, split } = settings;
  const s = useMemo(() => computeStats(days, goal), [days, goal]);
  const goals = macroGoals(settings);

  if (s.logged === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold">Son 7 gün</h2>
        <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-sm text-[var(--muted)]">
          Son 7 günde kayıtlı öğün yok. İstatistikler öğün ekledikçe burada belirir.
        </p>
        <button onClick={onGoAdd}
          className="w-full rounded-xl bg-[var(--accent)] py-3.5 font-semibold text-[var(--accent-ink)]">
          Öğün ekle
        </button>
      </div>
    );
  }

  const avgStatus = dayStatus(s.avg, goal);
  const diff = s.avg - goal;
  const pct = Math.min((s.avg / goal) * 100, 100);

  return (
    <div className="space-y-5">
      {/* Günlük ortalama */}
      <section className={cardCls}>
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-[var(--muted)]">Son 7 günün günlük ortalaması</p>
          <span className={`shrink-0 rounded-full border border-[var(--line)] px-2.5 py-1 text-xs font-medium ${avgStatus === "over" ? "text-[var(--over)]" : ""}`}>
            {STATUS_TEXT[avgStatus]}
          </span>
        </div>
        <p className="mt-2 text-4xl font-bold tabular-nums tracking-tight">
          {fmt(s.avg)} <span className="text-base font-medium text-[var(--muted)]">kcal</span>
        </p>
        <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-[var(--track)]" role="progressbar"
          aria-label="Ortalama alımın hedefe oranı" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(s.avg, goal)}>
          <div className="h-full rounded-full"
            style={{ width: `${pct}%`, background: avgStatus === "over" ? "var(--over)" : "var(--accent)", transition: "width .5s ease" }} />
        </div>
        <div className="mt-2 flex justify-between text-sm">
          <span className="text-[var(--muted)]">Hedef {fmt(goal)} kcal</span>
          <span className="font-medium tabular-nums">{diff >= 0 ? "+" : "−"}{fmt(Math.abs(diff))} kcal</span>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          {s.logged}/7 gün kayıtlı. Ortalama yalnızca kayıt girilen günlerden hesaplanır.
        </p>
      </section>

      {/* Seri */}
      <section className={cardCls}>
        <div className="flex items-center gap-4">
          <div className="rounded-2xl p-3" style={{ background: "color-mix(in srgb, var(--accent) 16%, transparent)" }}>
            <Flame size={28} className="text-[var(--accent)]" />
          </div>
          <div>
            <p className="text-3xl font-bold tabular-nums tracking-tight">
              {s.streak} <span className="text-base font-medium text-[var(--muted)]">gün seri</span>
            </p>
            <p className="text-sm text-[var(--muted)]">En uzun seri: {s.best} gün</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-7 gap-1.5">
          {s.week.map((d) => (
            <div key={d.key} className="flex flex-col items-center gap-1.5">
              <div role="img" aria-label={`${d.label}: ${STATUS_TEXT[d.status]}`}
                className="h-9 w-full rounded-lg" style={{ background: STATUS_COLOR[d.status] }} />
              <span className="text-[11px] text-[var(--muted)]">{d.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-[var(--muted)]">
          Son 7 günde {s.hits7} gün hedefte. Hedefin ±%{TOLERANCE * 100} aralığındaki günler seriye sayılır. Bugün tamamlanmadıysa seriyi bozmaz, hedefi aşarsan bozar.
        </p>
      </section>

      {/* Makro dağılımı */}
      <section className={cardCls}>
        <h2 className="text-base font-semibold">Haftalık makro dağılımı</h2>
        <div className="mt-4 space-y-3">
          <div>
            <p className="mb-1.5 flex justify-between text-xs text-[var(--muted)]"><span>Gerçekleşen</span><span>kalorinin payı</span></p>
            <SplitBar split={s.share} />
          </div>
          <div>
            <p className="mb-1.5 text-xs text-[var(--muted)]">Hedef</p>
            <SplitBar split={split} />
          </div>
        </div>
        <ul className="mt-5 space-y-4">
          {MACROS.map((m) => {
            const avg = s.macroAvg[m.key];
            const g = goals[m.key];
            return (
              <li key={m.key}>
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: m.color }} />
                    {m.label}
                  </span>
                  <span className="tabular-nums">{avg} / {g} g</span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--track)]">
                  <div className="h-full rounded-full"
                    style={{ width: `${g ? Math.min((avg / g) * 100, 100) : 0}%`, background: m.color, transition: "width .5s ease" }} />
                </div>
                <p className="mt-1 text-xs text-[var(--muted)]">Kalorinin %{s.share[m.key]}'i, hedef %{split[m.key]}</p>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-xs text-[var(--muted)]">Günlük ortalama gram, kayıt girilen günlerden hesaplanır.</p>
      </section>
    </div>
  );
}

/* ---------- Profil ve kişisel hesaplayıcı ---------- */
const ACTIVITY = [
  { id: "sedentary", label: "Hareketsiz (az egzersiz ya da hiç)", factor: 1.2 },
  { id: "light", label: "Hafif (haftada 1–3 gün)", factor: 1.375 },
  { id: "moderate", label: "Orta (haftada 3–5 gün)", factor: 1.55 },
  { id: "active", label: "Yüksek (haftada 6–7 gün)", factor: 1.725 },
  { id: "athlete", label: "Çok yüksek (günde 2 antrenman ya da ağır fiziksel iş)", factor: 1.9 },
];
const GOAL_MODES = [
  { value: "lose", label: "Kilo ver", delta: -500 },
  { value: "keep", label: "Koru", delta: 0 },
  { value: "gain", label: "Kilo al", delta: 300 },
];
const RANGES = { age: [18, 100], height: [120, 230], weight: [30, 300] };
const DEFAULT_PROFILE = { sex: "", age: "", height: "", weight: "", activity: "sedentary", mode: "keep" };

const loadProfile = () => {
  const p = read(KEYS.profile);
  return p && typeof p === "object" ? { ...DEFAULT_PROFILE, ...p } : DEFAULT_PROFILE;
};
const cleanNumber = (v) => {
  const x = String(v).replace(/,/g, ".").replace(/[^\d.]/g, "");
  const i = x.indexOf(".");
  return (i === -1 ? x : x.slice(0, i + 1) + x.slice(i + 1).replace(/\./g, "")).slice(0, 5);
};
const inRange = (v, [lo, hi]) => v !== "" && Number(v) >= lo && Number(v) <= hi;

// Mifflin-St Jeor: BMR = 10·kilo + 6,25·boy − 5·yaş + (erkek +5, kadın −161); TDEE = BMR × aktivite katsayısı
function calcProfile(p) {
  if (!["f", "m"].includes(p.sex) || !inRange(p.age, RANGES.age) || !inRange(p.height, RANGES.height) || !inRange(p.weight, RANGES.weight)) return null;
  const age = Number(p.age), h = Number(p.height), w = Number(p.weight);
  const bmr = Math.round(10 * w + 6.25 * h - 5 * age + (p.sex === "m" ? 5 : -161));
  const act = ACTIVITY.find((a) => a.id === p.activity) || ACTIVITY[0];
  const tdee = Math.round(bmr * act.factor);
  const bmi = w / (h / 100) ** 2;
  const mode = GOAL_MODES.find((m) => m.value === p.mode) || GOAL_MODES[1];
  const floor = p.sex === "m" ? 1500 : 1200; // kilo verirken önerilen alt sınır
  const raw = tdee + mode.delta;
  const floored = mode.delta < 0 && raw < floor;
  const target = clamp(Math.round((floored ? floor : raw) / 10) * 10, GOAL_MIN, GOAL_MAX);
  return { bmr, tdee, bmi, target, floored, floor };
}
const bmiLabel = (b) => (b < 18.5 ? "Zayıf" : b < 25 ? "Normal" : b < 30 ? "Fazla kilolu" : "Obez");

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
            value === o.value ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--muted)]"
          }`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BmiScale({ bmi }) {
  const MIN = 15, MAX = 40;
  const at = (v) => ((clamp(v, MIN, MAX) - MIN) / (MAX - MIN)) * 100;
  const segs = [[15, 18.5], [18.5, 25], [25, 30], [30, 40]];
  return (
    <div aria-hidden="true">
      <div className="relative flex h-4 items-center">
        <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
          {segs.map(([a, b], i) => (
            <div key={a} style={{ width: `${((b - a) / (MAX - MIN)) * 100}%`, background: i === 1 ? "var(--f)" : "color-mix(in srgb, var(--muted) 35%, var(--track))" }} />
          ))}
        </div>
        <div className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--surface)] bg-[var(--ink)]"
          style={{ left: `${at(bmi)}%` }} />
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-[var(--muted)]">
        {[18.5, 25, 30].map((v) => (
          <span key={v} className="absolute -translate-x-1/2" style={{ left: `${at(v)}%` }}>{String(v).replace(".", ",")}</span>
        ))}
      </div>
    </div>
  );
}

function ProfileTab({ profile, onChange, goal, onApplyGoal }) {
  const r = useMemo(() => calcProfile(profile), [profile]);
  const set = (k) => (e) => onChange({ ...profile, [k]: cleanNumber(e.target.value) });
  const bad = (k) => profile[k] !== "" && !inRange(profile[k], RANGES[k]);
  const anyBad = bad("age") || bad("height") || bad("weight");
  const done = r && goal === r.target;

  const num = (k, label, mode = "decimal") => (
    <label className="block text-xs text-[var(--muted)]">
      {label}
      <input className={`${inputCls} mt-1`} inputMode={mode} value={profile[k]} onChange={set(k)}
        placeholder="0" aria-invalid={bad(k)} />
    </label>
  );

  return (
    <div className="space-y-5">
      <section className={`${cardCls} space-y-4`}>
        <h2 className="text-base font-semibold">Kişisel bilgiler</h2>
        <div>
          <p className="mb-1.5 text-xs text-[var(--muted)]">Cinsiyet (formülde kullanılır)</p>
          <Segmented label="Cinsiyet" value={profile.sex} onChange={(sex) => onChange({ ...profile, sex })}
            options={[{ value: "f", label: "Kadın" }, { value: "m", label: "Erkek" }]} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {num("age", "Yaş", "numeric")}
          {num("height", "Boy (cm)")}
          {num("weight", "Kilo (kg)")}
        </div>
        {anyBad && (
          <p className="text-sm text-[var(--over)]" aria-live="polite">
            Yaş 18–100, boy 120–230 cm, kilo 30–300 kg aralığında olmalı.
          </p>
        )}
        <label className="block text-xs text-[var(--muted)]">
          Egzersiz sıklığı
          <select className={`${inputCls} mt-1`} value={profile.activity}
            onChange={(e) => onChange({ ...profile, activity: e.target.value })}>
            {ACTIVITY.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
      </section>

      {!r ? (
        <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-sm text-[var(--muted)]">
          BMR, TDEE ve BMI değerlerini görmek için cinsiyet, yaş, boy ve kilonu gir.
        </p>
      ) : (
        <>
          <section className={`${cardCls} space-y-4`}>
            <h2 className="text-base font-semibold">Sonuçların</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-[var(--bg)] p-4">
                <p className="text-xs text-[var(--muted)]">BMR</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{fmt(r.bmr)}</p>
                <p className="text-xs text-[var(--muted)]">kcal/gün, dinlenirken</p>
              </div>
              <div className="rounded-2xl bg-[var(--bg)] p-4">
                <p className="text-xs text-[var(--muted)]">TDEE</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{fmt(r.tdee)}</p>
                <p className="text-xs text-[var(--muted)]">kcal/gün, aktiviteyle</p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <p className="text-sm text-[var(--muted)]">Vücut kitle indeksi (BMI)</p>
                <span className="rounded-full border border-[var(--line)] px-2.5 py-1 text-xs font-medium">{bmiLabel(r.bmi)}</span>
              </div>
              <p className="text-2xl font-bold tabular-nums">
                {r.bmi.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              </p>
              <BmiScale bmi={r.bmi} />
            </div>
          </section>

          <section className={`${cardCls} space-y-4`}>
            <h2 className="text-base font-semibold">Günlük kalori hedefin</h2>
            <Segmented label="Hedef türü" value={profile.mode} onChange={(mode) => onChange({ ...profile, mode })}
              options={GOAL_MODES} />
            <div>
              <p className="text-xs text-[var(--muted)]">Önerilen günlük hedef</p>
              <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight">
                {fmt(r.target)} <span className="text-base font-medium text-[var(--muted)]">kcal</span>
              </p>
              {r.floored && (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  −500 kcal'lik açık bu değerin altına düşeceği için önerilen alt sınır olan {fmt(r.floor)} kcal kullanıldı.
                </p>
              )}
            </div>
            <button disabled={done} onClick={() => onApplyGoal(r.target)}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] py-3.5 font-semibold text-[var(--accent-ink)] disabled:opacity-60">
              {done ? <><Check size={18} /> Günlük hedef olarak ayarlandı</> : "Günlük hedef olarak ayarla"}
            </button>
            {!done && <p className="text-center text-xs text-[var(--muted)]">Şu anki hedefin: {fmt(goal)} kcal</p>}
          </section>
        </>
      )}

      <p className="text-xs leading-relaxed text-[var(--muted)]">
        Değerler Mifflin-St Jeor formülüyle hesaplanan tahminlerdir ve tıbbi tavsiye yerine geçmez. Kilo verme ya da sağlık durumuna bağlı bir hedef için doktor ya da diyetisyene danış. Bilgilerin yalnızca bu tarayıcıda saklanır.
      </p>
    </div>
  );
}

/* ---------- Ayarlar ---------- */
function GoalField({ goal, onChange }) {
  const [draft, setDraft] = useState(String(goal));
  useEffect(() => setDraft(String(goal)), [goal]);
  const n = Number(draft);
  const ok = n >= GOAL_MIN && n <= GOAL_MAX;
  const step = (d) => onChange(clamp(goal + d, GOAL_MIN, GOAL_MAX));
  const btn = "rounded-full border border-[var(--line)] bg-[var(--surface)] p-3 disabled:opacity-40";

  return (
    <div>
      <div className="flex items-center gap-3">
        <button className={btn} onClick={() => step(-50)} disabled={goal <= GOAL_MIN} aria-label="Hedefi 50 kcal azalt">
          <Minus size={18} />
        </button>
        <div className="relative flex-1">
          <input className={`${inputCls} pr-14 text-center text-xl font-semibold tabular-nums`} inputMode="numeric"
            value={draft} aria-label="Günlük hedef kalori" aria-invalid={!ok}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, "").slice(0, 4);
              setDraft(val);
              if (Number(val) >= GOAL_MIN && Number(val) <= GOAL_MAX) onChange(Number(val));
            }}
            onBlur={() => setDraft(String(goal))} />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[var(--muted)]">kcal</span>
        </div>
        <button className={btn} onClick={() => step(50)} disabled={goal >= GOAL_MAX} aria-label="Hedefi 50 kcal artır">
          <Plus size={18} />
        </button>
      </div>
      <p className={`mt-2 text-sm ${ok ? "text-[var(--muted)]" : "text-[var(--over)]"}`} aria-live="polite">
        {ok ? "Günlük ihtiyacına göre bir hedef seç." : `Hedef ${fmt(GOAL_MIN)} ile ${fmt(GOAL_MAX)} kcal arasında olmalı.`}
      </p>
    </div>
  );
}

function GeminiSection({ gemini, onSave }) {
  const [key, setKey] = useState(gemini.key);
  const [model, setModel] = useState(gemini.model);
  const [show, setShow] = useState(false);
  const dirty = key.trim() !== gemini.key || model.trim() !== gemini.model;

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Yapay zeka (Gemini)</h2>
      <div className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <label className="block text-xs text-[var(--muted)]">
          API anahtarı
          <div className="relative mt-1">
            <input className={`${inputCls} pr-12`} type={show ? "text" : "password"} value={key}
              onChange={(e) => setKey(e.target.value)} placeholder="Gemini API anahtarını yapıştır"
              autoComplete="off" autoCapitalize="off" spellCheck={false} />
            <button onClick={() => setShow((s) => !s)} aria-label={show ? "Anahtarı gizle" : "Anahtarı göster"}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-2 text-[var(--muted)]">
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </label>
        <label className="block text-xs text-[var(--muted)]">
          Model
          <input className={`${inputCls} mt-1`} value={model} onChange={(e) => setModel(e.target.value)}
            autoCapitalize="off" spellCheck={false} />
        </label>
        <div className="flex gap-3">
          <button disabled={!dirty} onClick={() => onSave({ key: key.trim(), model: model.trim() || DEFAULT_MODEL })}
            className="flex-1 rounded-xl bg-[var(--accent)] py-3 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-40">
            Kaydet
          </button>
          {gemini.key && (
            <button onClick={() => { setKey(""); onSave({ key: "", model: model.trim() || DEFAULT_MODEL }); }}
              className="rounded-xl border border-[var(--line)] px-4 py-3 text-sm font-medium text-[var(--over)]">
              Anahtarı sil
            </button>
          )}
        </div>
        <p className="text-sm text-[var(--muted)]" aria-live="polite">
          {gemini.key ? `Kayıtlı anahtar: •••• ${gemini.key.slice(-4)}` : "Henüz anahtar eklenmedi."}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-[var(--muted)]">
        Anahtar yalnızca bu tarayıcının localStorage alanında düz metin olarak saklanır. İstekler doğrudan tarayıcından Google'a gider. Ortak kullanılan cihazlarda anahtar girme ve Google AI Studio'da anahtarına kullanım kısıtlaması koy.
      </p>
    </section>
  );
}

function SettingsTab({ settings, onChange, onReset, gemini, onSaveGemini }) {
  const goals = macroGoals(settings);
  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Günlük kalori hedefi</h2>
        <GoalField goal={settings.goal} onChange={(goal) => onChange({ ...settings, goal })} />
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Makro dağılımı</h2>
        <div className="flex h-3 overflow-hidden rounded-full bg-[var(--track)]" aria-hidden="true">
          {MACROS.map((m) => (
            <div key={m.key} style={{ width: `${settings.split[m.key]}%`, background: m.color, transition: "width .25s ease" }} />
          ))}
        </div>
        <div className="space-y-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          {MACROS.map((m) => (
            <div key={m.key}>
              <div className="mb-2 flex items-baseline justify-between text-sm">
                <label htmlFor={`split-${m.key}`} className="font-medium">{m.label}</label>
                <span className="tabular-nums text-[var(--muted)]">
                  %{settings.split[m.key]} · {goals[m.key]} g
                </span>
              </div>
              <input id={`split-${m.key}`} type="range" min="0" max="100" step="1"
                value={settings.split[m.key]} className="h-2 w-full cursor-pointer"
                style={{ accentColor: m.color }}
                onChange={(e) => onChange({ ...settings, split: rebalance(settings.split, m.key, Number(e.target.value)) })} />
            </div>
          ))}
        </div>
        <p className="text-sm text-[var(--muted)]">
          Bir oranı değiştirince diğer ikisi otomatik dengelenir, toplam her zaman %100 kalır. Gram hedefleri protein ve karbonhidrat için 4 kcal, yağ için 9 kcal üzerinden hesaplanır.
        </p>
      </section>

      <GeminiSection key={`${gemini.key}|${gemini.model}`} gemini={gemini} onSave={onSaveGemini} />

      <button onClick={onReset}
        className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] py-3 text-sm font-medium text-[var(--muted)]">
        Hedefleri varsayılana döndür ({fmt(DEFAULT_SETTINGS.goal)} kcal, %25 / %45 / %30)
      </button>
    </div>
  );
}

/* ---------- Ana bileşen ---------- */
export default function Caloroid() {
  const [tab, setTab] = useState("home");
  const [dark, setDark] = useState(loadDark);
  const [days, setDays] = useState(loadDays);
  const [settings, setSettings] = useState(loadSettings);
  const [gemini, setGemini] = useState(loadGemini);
  const [profile, setProfile] = useState(loadProfile);

  useEffect(() => write(KEYS.days, { days }), [days]);
  useEffect(() => write(KEYS.settings, settings), [settings]);
  useEffect(() => write(KEYS.gemini, gemini), [gemini]);
  useEffect(() => write(KEYS.profile, profile), [profile]);
  useEffect(() => write(KEYS.theme, dark ? "dark" : "light"), [dark]);

  const today = dateKey();
  const meals = days[today] || [];
  const totals = useMemo(() => sumMeals(meals), [meals]);

  const addMeal = (m) => setDays((d) => ({ ...d, [today]: [...(d[today] || []), m] }));
  const removeMeal = (id) => setDays((d) => ({ ...d, [today]: (d[today] || []).filter((m) => m.id !== id) }));

  return (
    <div data-theme={dark ? "dark" : "light"}
      className="caloroid min-h-screen bg-[var(--bg)] text-[var(--ink)]"
      style={{ fontFamily: "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, sans-serif" }}>
      <style>{theme}</style>

      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col">
        <header className="flex items-center justify-between px-5 pb-4 pt-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Caloroid</h1>
            <p className="text-sm text-[var(--muted)]">{tab === "home" ? "Bugün" : TABS.find((t) => t.id === tab).label}</p>
          </div>
          <button onClick={() => setDark((d) => !d)} aria-label="Temayı değiştir"
            className="rounded-full border border-[var(--line)] bg-[var(--surface)] p-2.5">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>

        <main className="flex-1 px-5 pb-28">
          {tab === "home" && <HomeTab meals={meals} totals={totals} settings={settings} onDelete={removeMeal} />}
          {tab === "add" && (
            <AddTab split={settings.split} gemini={gemini} onGoSettings={() => setTab("settings")}
              onAdd={(m) => { addMeal(m); setTab("home"); }} />
          )}
          {tab === "history" && <HistoryTab days={days} settings={settings} onGoAdd={() => setTab("add")} />}
          {tab === "profile" && (
            <ProfileTab profile={profile} onChange={setProfile} goal={settings.goal}
              onApplyGoal={(goal) => setSettings((s) => ({ ...s, goal }))} />
          )}
          {tab === "settings" && (
            <SettingsTab settings={settings} onChange={setSettings} onReset={() => setSettings(DEFAULT_SETTINGS)}
              gemini={gemini} onSaveGemini={setGemini} />
          )}
        </main>

        <nav aria-label="Ana gezinme"
          className="fixed bottom-0 left-1/2 w-full max-w-md -translate-x-1/2 border-t border-[var(--line)] px-2 pt-2"
          style={{
            paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))",
            background: "color-mix(in srgb, var(--surface) 72%, transparent)",
            backdropFilter: "blur(18px) saturate(1.5)",
            WebkitBackdropFilter: "blur(18px) saturate(1.5)",
          }}>
          <ul className="flex">
            {TABS.map(({ id, label, Icon }) => {
              const active = tab === id;
              return (
                <li key={id} className="flex-1">
                  <button onClick={() => setTab(id)} aria-current={active ? "page" : undefined}
                    className={`flex w-full flex-col items-center gap-1 rounded-xl py-2 text-xs font-medium transition-colors ${
                      active ? "text-[var(--accent)]" : "text-[var(--muted)]"
                    }`}>
                    <Icon size={22} strokeWidth={active ? 2.4 : 1.8} />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
}