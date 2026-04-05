const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_LOCAL;
// just to be safe I will fetch it if the env var exists
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
fetch(url).then(res => res.json()).then(console.log).catch(console.error);
