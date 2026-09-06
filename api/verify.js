// /api/verify.js
// Vercel serverless function. Keeps the OpenAI API key on the server —
// never expose it in the front-end index.html.
//
// Setup:
//   1. In your Vercel project → Settings → Environment Variables, add:
//        OPENAI_API_KEY = sk-...
//   2. Redeploy. The front-end already calls fetch('/api/verify', ...)
//      from runVerification() in index.html, with an automatic fallback
//      to the local demo classifier if this endpoint is missing/unset.
//
// Input body (JSON):
//   { type: 'text' | 'link' | 'image' | 'video', text: string, image: string|null }
//   - image is a base64 data URL (for 'image': the uploaded screenshot;
//     for 'video': a single frame captured client-side from the clip,
//     since raw video can't be sent to a vision model directly).
//
// Output body (JSON):
//   { verdict: 'true'|'misleading'|'false'|'unverified', confidence: number,
//     explanation_en: string, explanation_fil: string }

const VALID_VERDICTS = ['true', 'misleading', 'false', 'unverified'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'OPENAI_API_KEY not configured on the server.' });
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
      '"explanation_fil":"<1-2 sentence explanation in Filipino>"}. ' +
      'If a video frame is provided, remember it is only one still frame, not the full video or audio — ' +
      'be appropriately cautious and lean toward "unverified" when the frame alone can\'t settle the claim.';

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

    const userContent = [{ type: 'text', text: userTextParts.join('\n') }];
    if (image && typeof image === 'string' && image.startsWith('data:image/')) {
      userContent.push({ type: 'image_url', image_url: { url: image } });
    }

    const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!openaiResp.ok) {
      const errText = await openaiResp.text().catch(() => '');
      console.error('OpenAI error:', openaiResp.status, errText);
      res.status(502).json({ error: 'AI provider error' });
      return;
    }

    const data = await openaiResp.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) {
      res.status(502).json({ error: 'Empty AI response' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      res.status(502).json({ error: 'Could not parse AI response' });
      return;
    }

    const verdict = VALID_VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'unverified';
    const confidence = Math.max(1, Math.min(99, Math.round(Number(parsed.confidence) || 50)));
    const explanation_en = (parsed.explanation_en || '').toString().slice(0, 500) || 'No explanation provided.';
    const explanation_fil = (parsed.explanation_fil || '').toString().slice(0, 500) || 'Walang ibinigay na paliwanag.';

    res.status(200).json({ verdict, confidence, explanation_en, explanation_fil });
  } catch (err) {
    console.error('verify.js error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
};
