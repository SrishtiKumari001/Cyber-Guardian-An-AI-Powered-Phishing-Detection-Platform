// -----------------------------------------------------------------------------
// server.js - Cyber Security Edition (DEBUGGING VERSION)
// -----------------------------------------------------------------------------
// This version uses a hardcoded API key to bypass any .env file issues.
// IMPORTANT: This is for testing only. Do not use this in a real application.
// -----------------------------------------------------------------------------


// backend/server.js (CommonJS version with robust 429 handling, retries, and safe fallbacks)
// Run with: node server.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');

// =====================
//  Configuration
// =====================
const GEMINI_API_KEY = "AIzaSyDLyHaqelU5egRZmu2uJKnOYJxlle8C0Sc"; 
const PORT = process.env.PORT || 5000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';


if (!GEMINI_API_KEY) {
  console.error('\n❌ ERROR: Missing GEMINI_API_KEY environment variable.\n' +
    'Set it like:  set GEMINI_API_KEY=your_key (Windows)  or  export GEMINI_API_KEY=your_key (macOS/Linux)\n');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

// =====================
//  Helpers
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Extract a retry delay from Google error format if available
function extractRetryDelayMs(error) {
  try {
    const data = error?.response?.data || {};
    // Google often returns details[].retryDelay like '49s'
    const details = data.details || data.error?.details || [];
    for (const d of details) {
      if (typeof d?.retryDelay === 'string') {
        const m = d.retryDelay.match(/(\d+)(?:\.(\d+))?s/); // seconds with optional fraction
        if (m) {
          const seconds = parseInt(m[1], 10);
          return seconds * 1000;
        }
      }
    }
    // Try standard Retry-After header
    const retryAfter = error?.response?.headers?.['retry-after'];
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (!Number.isNaN(secs)) return secs * 1000;
    }
  } catch (_) {}
  return null;
}

// Generic POST with retries for Gemini endpoints
async function geminiPost(url, payload, { maxRetries = 2, baseDelayMs = 3000 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await axios.post(url, payload, { timeout: 60000 });
    } catch (err) {
      const status = err?.response?.status;
      const quota = status === 429 || status === 503;
      if (quota && attempt < maxRetries) {
        const serverDelay = extractRetryDelayMs(err);
        const backoff = serverDelay ?? baseDelayMs * Math.pow(2, attempt); // exponential backoff if no server hint
        console.warn(`⚠️ Gemini rate/availability issue (status ${status}). Retrying in ${Math.ceil(backoff/1000)}s...`);
        await sleep(backoff);
        attempt += 1;
        continue;
      }
      // Bubble up other errors or if retries exhausted
      throw err;
    }
  }
}

function geminiModelUrl(model) {
  // Text/JSON models: .../models/<model>:generateContent
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

// Convenience wrappers
async function callGeminiText(model, promptOrParts, opts = {}) {
  const url = geminiModelUrl(model);
  const contents = Array.isArray(promptOrParts)
    ? [{ parts: promptOrParts }]
    : [{ parts: [{ text: String(promptOrParts) }] }];
  const payload = { contents, ...(opts || {}) };
  return geminiPost(url, payload, { maxRetries: 2 });
}

async function callGeminiJSON(model, prompt) {
  return callGeminiText(model, [{ text: prompt }], { generationConfig: { responseMimeType: 'application/json' } });
}

async function callGeminiTTS(model, text) {
  const url = geminiModelUrl(model); // TTS model also uses :generateContent
  const payload = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'] },
    model,
  };
  return geminiPost(url, payload, { maxRetries: 2 });
}

// =====================
//  URL Phishing Helpers
// =====================
const extractUrlFeatures = (url) => {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    const query = parsedUrl.search;

    const features = {
      NumDots: (url.match(/\./g) || []).length,
      PathLevel: (path.match(/\//g) || []).length,
      UrlLength: url.length,
      NumDash: (url.match(/-/g) || []).length,
      NumNumericChars: (url.match(/\d/g) || []).length,
      PathLength: path.length,
      QueryLength: query.length,
      Hostname: parsedUrl.hostname,
      PctExtHyperlinks: 0.0,
      PctExtResourceUrls: 0.0,
      InsecureForms: 0,
      PctNullSelfRedirectHyperlinks: 0.0,
      FrequentDomainNameMismatch: 0,
      SubmitInfoToEmail: 0,
      ExtMetaScriptLinkRT: 0,
      PctExtNullSelfRedirectHyperlinksRT: 0.0,
    };
    const selectedFeatureNames = [
      'NumDots', 'PathLevel', 'UrlLength', 'NumDash', 'NumNumericChars', 'PathLength', 'QueryLength',
      'PctExtHyperlinks', 'PctExtResourceUrls', 'InsecureForms', 'PctNullSelfRedirectHyperlinks', 'FrequentDomainNameMismatch',
      'SubmitInfoToEmail', 'ExtMetaScriptLinkRT', 'PctExtNullSelfRedirectHyperlinksRT'
    ];
    const featureValues = selectedFeatureNames.map((name) => features[name]);
    featureValues.push(features['Hostname']);
    return featureValues;
  } catch (e) {
    return null;
  }
};

const predictPhishing = (features, url) => {
  const [numDots, pathLevel, urlLength, numDash] = features;
  const hostname = features[features.length - 1];
  let phishingScore = 0;
  if (urlLength > 75) phishingScore += 2;
  if (numDots > 3) phishingScore += 3;
  if (pathLevel > 4) phishingScore += 1;
  if (numDash > 4) phishingScore += 1;
  const suspiciousKeywords = ['login', 'secure', 'account', 'update', 'verify', 'signin', 'bank'];
  if (suspiciousKeywords.some((kw) => url.toLowerCase().includes(kw))) phishingScore += 1;
  if (url.includes('..')) phishingScore += 4;
  const ipRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (ipRegex.test(hostname)) phishingScore += 4;
  return phishingScore >= 4 ? 1 : 0;
};

// =====================
//  Routes
// =====================
app.get('/', (_req, res) => {
  res.send('✅ Cyber Security Tutor backend is running!');
});

app.post('/api/predict-url', (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL is required.' });
  const features = extractUrlFeatures(url);
  if (!features) return res.status(400).json({ error: 'Invalid URL format.' });
  try {
    const prediction = predictPhishing(features, url);
    res.json({ prediction: prediction === 1 ? 'Phishing' : 'Legitimate' });
  } catch (error) {
    console.error('Error in /api/predict-url:', error);
    res.status(500).json({ error: 'Failed to make a prediction.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, language = 'en' } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    // 1) TEXT
    const textPrompt = `You are a friendly Cyber Security Tutor. Respond to the following message in a helpful, concise way in ${language}. Message: "${message}"`;
    const textResp = await callGeminiText('gemini-2.5-flash-preview-05-20', textPrompt);
    const aiTextReply = textResp?.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'I could not generate a reply.';

    // 2) TTS (best-effort)
    let audioData = null;
    let mimeType = null;
    try {
      const ttsResp = await callGeminiTTS('gemini-2.5-flash-preview-tts', aiTextReply);
      const part = ttsResp?.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      audioData = part?.data || null;
      mimeType = part?.mimeType || null;
    } catch (ttsErr) {
      const status = ttsErr?.response?.status;
      console.warn(`TTS unavailable (status ${status || 'n/a'}). Returning text-only.`);
    }

    return res.json({ text: aiTextReply, audio: audioData, mimeType });
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    console.error('Error in /api/chat:', status, JSON.stringify(data)?.slice(0, 400));

    // Graceful messaging on quota/limits
    if (status === 429) {
      return res.status(429).json({ error: 'The AI tutor is currently rate-limited. Please try again shortly.' });
    }

    return res.status(500).json({ error: 'Failed to get a response from the AI.' });
  }
});

app.post('/api/learning-modules', async (_req, res) => {
  const prompt = `For each of the following cybersecurity threats [Phishing, Malware, Ransomware, Man-in-the-Middle Attack, Denial-of-Service (DoS), SQL Injection], provide: 1. A concise explanation (2-3 sentences). 2. A "how_it_works" breakdown as an array of 3-4 short, simple steps. 3. Three key "prevention_tips" as an array of 3 strings. Format the entire response as a JSON object with a key 'modules', which is an array of objects. Each object must have 'threat', 'explanation', 'how_it_works', and 'prevention_tips' keys.`;
  try {
    const resp = await callGeminiJSON('gemini-2.5-flash-preview-05-20', prompt);
    res.json(resp.data);
  } catch (error) {
    const status = error?.response?.status;
    console.error('Error in /api/learning-modules:', status, error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch learning modules.' });
  }
});

app.post('/api/tool', async (req, res) => {
  const { tool, prompt } = req.body || {};
  if (!tool || !prompt) return res.status(400).json({ error: 'Tool and prompt are required' });
  try {
    const resp = await callGeminiJSON('gemini-2.5-flash-preview-05-20', prompt);
    res.json(resp.data);
  } catch (error) {
    const status = error?.response?.status;
    console.error(`Error in /api/tool for ${tool}:`, status, error?.response?.data || error.message);
    res.status(500).json({ error: `Failed to get a response for ${tool}.` });
  }
});

// =====================
//  Start
// =====================
app.listen(PORT, () => {
  console.log(`✨ Cyber Security Tutor backend server running on http://localhost:${PORT}`);
  console.log(`🌐 CORS origin allowed: ${FRONTEND_ORIGIN}`);
});
