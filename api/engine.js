const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const LANGUAGE_LOCALES = {
  en: "en-IN", hi: "hi-IN", bn: "bn-IN", or: "or-IN", ta: "ta-IN", te: "te-IN",
  mr: "mr-IN", gu: "gu-IN", kn: "kn-IN", ml: "ml-IN", pa: "pa-IN", ur: "ur-IN",
  fr: "fr-FR", es: "es-ES", de: "de-DE", it: "it-IT", pt: "pt-BR", ru: "ru-RU",
  ja: "ja-JP", ko: "ko-KR", "zh-CN": "zh-CN", ar: "ar-SA", tr: "tr-TR", nl: "nl-NL", pl: "pl-PL"
};

const cache = { voices: null, expires: 0 };

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8").send(JSON.stringify(body));
}

function cleanJsonText(text) {
  if (!text) throw new Error("AI returned an empty response.");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced ? fenced[1] : text).trim();
}

async function generateScript(body) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured in Vercel.");
  const {
    topic = "Your Topic", duration = 45, languageName = "English", audience = "General",
    contentStyle = "Fast & Viral", hookStyle = "Curiosity"
  } = body;

  const prompt = `Create a short-form vertical social media reel script.
Topic: ${topic}
Target language: ${languageName}
Duration: ${duration} seconds
Audience: ${audience}
Content style: ${contentStyle}
Hook style: ${hookStyle}

Requirements:
- Write the hook, every scene, caption, and hashtags in the target language.
- Do not silently switch to English or mix languages unless a proper name or technical term naturally needs it.
- Make the script sound native and natural for the target language, not word-for-word translation.
- Create exactly 6 scenes.
- Match the requested duration approximately. Keep it concise enough for a spoken reel.
- Hook should be strong and match the selected hook style.
- Scene titles should be short.
- Avoid unsupported exact statistics or claims you cannot justify from the topic alone.
- Return ONLY valid JSON. No markdown and no extra text.

JSON shape:
{
  "hook": "...",
  "scenes": [
    {"title":"...","text":"..."},
    {"title":"...","text":"..."},
    {"title":"...","text":"..."},
    {"title":"...","text":"..."},
    {"title":"...","text":"..."},
    {"title":"...","text":"..."}
  ],
  "caption":"...",
  "hashtags":["#...","#...","#..."]
}`;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_MODEL, input: prompt, max_output_tokens: 1600 })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "OpenAI request failed.");
  const raw = cleanJsonText(data?.output_text || "");
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error("AI returned invalid reel JSON. Try Generate again."); }
  if (!parsed.hook || !Array.isArray(parsed.scenes) || parsed.scenes.length !== 6) {
    throw new Error("AI returned an incomplete reel. Try Generate again.");
  }
  parsed.scenes = parsed.scenes.map((s, i) => ({
    title: String(s?.title || `Scene ${i + 1}`).trim(),
    text: String(s?.text || "").trim()
  }));
  parsed.caption = String(parsed.caption || topic).trim();
  parsed.hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String).slice(0, 8) : [];
  return parsed;
}

async function listVoices() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) throw new Error("AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are not configured in Vercel.");
  if (cache.voices && Date.now() < cache.expires) return cache.voices;
  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
  const r = await fetch(endpoint, { headers: { "Ocp-Apim-Subscription-Key": key } });
  if (!r.ok) throw new Error(`Azure voice list failed (${r.status}).`);
  const voices = await r.json();
  cache.voices = Array.isArray(voices) ? voices : [];
  cache.expires = Date.now() + 10 * 60 * 1000;
  return cache.voices;
}

function supportsLocale(v, locale) {
  if (v?.Locale === locale) return true;
  const secondary = v?.SecondaryLocaleList || v?.SecondaryLocale || [];
  return Array.isArray(secondary) && secondary.includes(locale);
}

function pickVoice(voices, locale) {
  const exact = voices.filter(v => supportsLocale(v, locale));
  const neural = exact.find(v => /Neural/i.test(v?.ShortName || v?.Name || ""));
  if (neural) return neural;
  if (exact[0]) return exact[0];
  const base = locale.split("-")[0].toLowerCase();
  const related = voices.filter(v => String(v?.Locale || "").toLowerCase().startsWith(base + "-"));
  const relatedNeural = related.find(v => /Neural/i.test(v?.ShortName || v?.Name || ""));
  return relatedNeural || related[0] || null;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function voiceProsody(style) {
  if (style === "Energetic") return { rate: "+8%", pitch: "+4%" };
  if (style === "Calm") return { rate: "-8%", pitch: "-2%" };
  if (style === "Dramatic") return { rate: "-4%", pitch: "-6%" };
  return { rate: "0%", pitch: "0%" };
}

async function synthesize(body) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) throw new Error("AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are not configured in Vercel.");
  const language = body.language || "en";
  const locale = LANGUAGE_LOCALES[language];
  if (!locale) throw new Error("Selected language is not configured.");
  const text = String(body.text || "").trim();
  if (!text) throw new Error("No text supplied for voiceover.");
  const voices = await listVoices();
  const voice = pickVoice(voices, locale);
  if (!voice) throw new Error(`Azure Speech has no voice available for ${body.languageName || language} in this region.`);
  const shortName = voice.ShortName;
  const { rate, pitch } = voiceProsody(body.voiceStyle);
  const ssml = `<speak version="1.0" xml:lang="${xmlEscape(locale)}" xmlns="http://www.w3.org/2001/10/synthesis"><voice name="${xmlEscape(shortName)}"><prosody rate="${rate}" pitch="${pitch}">${xmlEscape(text)}</prosody></voice></speak>`;
  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-160kbitrate-mono-mp3",
      "User-Agent": "AI-Reel-Maker"
    },
    body: ssml
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Azure TTS failed (${r.status}). ${msg.slice(0, 240)}`);
  }
  const audio = Buffer.from(await r.arrayBuffer());
  return { audio, voice: shortName, locale };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only." });
  try {
    const body = req.body || {};
    if (body.action === "generate") {
      const script = await generateScript(body);
      return json(res, 200, script);
    }
    if (body.action === "tts") {
      const result = await synthesize(body);
      res.status(200)
        .setHeader("Content-Type", "audio/mpeg")
        .setHeader("Cache-Control", "no-store")
        .setHeader("X-AI-Voice", result.voice)
        .setHeader("X-AI-Locale", result.locale)
        .send(result.audio);
      return;
    }
    return json(res, 400, { error: "Unknown action." });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e?.message || "Server error." });
  }
};
