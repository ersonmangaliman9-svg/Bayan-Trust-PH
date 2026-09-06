// /api/verify.js
// Vercel serverless function. Keeps AI provider keys on the server —
// never expose them in the front-end index.html.
//
// Setup (pick ONE provider, or set both for automatic fallback):
//   • Google Gemini (recommended — has a genuinely free tier):
//       1. Get a free key at https://aistudio.google.com → "Get API Key".
//       2. In Vercel → Settings → Environment Variables, add:
//            GEMINI_API_KEY = AIza...
//          Optionally also GEMINI_MODEL (defaults to 'gemini-2.5-flash').
//   • OpenAI (paid — needs a funded platform.openai.com billing balance):
//       1. In Vercel → Settings → Environment Variables, add:
//            OPENAI_API_KEY = sk-...
//          Optionally also OPENAI_MODEL (defaults to 'gpt-4o-mini').
//   If BOTH keys are set, Gemini is tried first and OpenAI is used only
//   if the Gemini call fails (e.g. free-tier rate limit hit) — so you
//   can keep OpenAI as a paid safety net without it costing anything
//   unless Gemini is actually down or over quota.
//
//   After adding/changing any of the above: redeploy — adding an env
//   var does NOT automatically redeploy already-running functions
//   (Deployments → ... → Redeploy).
//
//   The front-end already calls fetch('/api/verify', ...) from
//   runVerification() in index.html, with an automatic fallback to the
//   local demo classifier if this endpoint is missing/unset/erroring.
//   If verification keeps falling back to demo mode even with a key
//   set, check this function's logs (Deployments → latest →
//   Functions/Logs → /api/verify) for the exact error.
//
// Input body (JSON):
//   { type: 'text' | 'link' | 'image' | 'video', text: string, image: string|null }
//   - image is a base64 data URL (for 'image': the uploaded screenshot;
//     for 'video': a single frame captured client-side from the clip,
//     since raw video can't be sent to a vision model directly).
//
// Output body (JSON):
//   { verdict: 'true'|'misleading'|'false'|'unverified', confidence: number,
//     explanation_en: string, explanation_fil: string, search_query: string }

const VALID_VERDICTS = ['true', 'misleading', 'false', 'unverified'];

// Parses the model's raw JSON-text reply into the shape our front-end
// expects. Shared by both providers so validation/sanitizing only lives
// in one place.
function parseModelJson(raw) {
  const parsed = JSON.parse(raw);
  const verdict = VALID_VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'unverified';
  const confidence = Math.max(1, Math.min(99, Math.round(Number(parsed.confidence) || 50)));
  const explanation_en = (parsed.explanation_en || '').toString().slice(0, 500) || 'No explanation provided.';
  const explanation_fil = (parsed.explanation_fil || '').toString().slice(0, 500) || 'Walang ibinigay na paliwanag.';
  const search_query = (parsed.search_query || '').toString().trim().slice(0, 200);
  return { verdict, confidence, explanation_en, explanation_fil, search_query };
}

// Calls Google's Gemini API (generateContent). Throws on any failure —
// caller decides whether to fall back to another provider.
async function callGemini(apiKey, systemPrompt, userText, image) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const parts = [{ text: userText }];
  if (image && typeof image === 'string' && image.startsWith('data:image/')) {
    const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
  }
  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 400, responseMimeType: 'application/json' },
      }),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('Gemini error (model=' + model + '): ' + resp.status + ' ' + errText);
  }
  const data = await resp.json();
  const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!raw) throw new Error('Gemini returned an empty response (possibly blocked by safety filters).');
  return parseModelJson(raw);
}

// Calls OpenAI's chat completions API. Throws on any failure — caller
// decides whether to fall back to another provider.
async function callOpenAI(apiKey, systemPrompt, userText, image) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const userContent = [{ type: 'text', text: userText }];
  if (image && typeof image === 'string' && image.startsWith('data:image/')) {
    userContent.push({ type: 'image_url', image_url: { url: image } });
  }
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: model,
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('OpenAI error (model=' + model + '): ' + resp.status + ' ' + errText);
  }
  const data = await resp.json();
  const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!raw) throw new Error('OpenAI returned an empty response.');
  return parseModelJson(raw);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!geminiKey && !openaiKey) {
    res.status(503).json({ error: 'No AI provider configured (set GEMINI_API_KEY and/or OPENAI_API_KEY).' });
    return;
  }

  try {
    const { type, text, image } = req.body || {};
    const safeType = ['text', 'link', 'image', 'video'].includes(type) ? type : 'text';
    const safeText = (text || '').toString().slice(0, 4000);

    const systemPrompt =
      'You are Bayan Trust, a Filipino fact-checking assistant. You assess whether a ' +
      'social-media post (text, link, screenshot, or a still frame taken from a video) ' +
      'is likely true, misleading, false, or unverified, focused on claims common in the ' +
      'Philippines (government aid/ayuda scams, disaster misinformation, health hoaxes, ' +
      'manipulated or out-of-context media, political claims, etc). ' +
      'Reply ONLY with a compact JSON object, no markdown, no code fences, with this exact shape: ' +
      '{"verdict":"true|misleading|false|unverified","confidence":<0-99 integer>,' +
      '"explanation_en":"<1-2 sentence explanation in English>",' +
      '"explanation_fil":"<1-2 sentence explanation in Filipino>",' +
      '"search_query":"<a short, plain-English web search phrase (6-14 words) describing the SPECIFIC ' +
      'claim/event/people/place shown or described in the post, written so it could find real news ' +
      'coverage or fact-checks about this exact topic anywhere on the web — not the filename, not generic ' +
      'words like screenshot or video>"}. ' +
      'If a video frame is provided, remember it is only one still frame, not the full video or audio — ' +
      'be appropriately cautious and lean toward "unverified" when the frame alone can\'t settle the claim. ' +
      'Base the search_query on what you can actually see/read (people, place, event, claim, date), not on ' +
      'the file type or name.';

    const userTextParts = [];
    if (safeType === 'video') {
      userTextParts.push(
        'Content type: video (a single representative frame is attached as an image). ' +
        'Filename/context: ' + (safeText || '(none)')
      );
    } else if (safeType === 'image') {
      userTextParts.push('Content type: screenshot/image. Filename/context: ' + (safeText || '(none)'));
    } else if (safeType === 'link') {
      userTextParts.push('Content type: shared post link. URL: ' + (safeText || '(none)'));
    } else {
      userTextParts.push('Content type: pasted text/caption. Content: ' + (safeText || '(none)'));
    }
    const userText = userTextParts.join('\n');

    // Gemini first (it's the free one) — OpenAI only as a fallback, and
    // only if it's actually configured. Either provider's failure is
    // logged with which one it was, so the real cause always shows up
    // in Vercel's Function Logs instead of just a generic 502.
    const attempts = [];
    if (geminiKey) attempts.push(() => callGemini(geminiKey, systemPrompt, userText, image));
    if (openaiKey) attempts.push(() => callOpenAI(openaiKey, systemPrompt, userText, image));

    let result = null;
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        result = await attempt();
        break;
      } catch (e) {
        lastErr = e;
        console.error(e.message);
      }
    }

    if (!result) {
      res.status(502).json({ error: 'AI provider error: ' + (lastErr ? lastErr.message : 'unknown') });
      return;
    }

    res.status(200).json(result);
  } catch (err) {
    console.error('verify.js error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
};
