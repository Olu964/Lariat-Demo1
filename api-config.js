/*
 * Optional frontend API configuration.
 *
 * Leave this empty when the same origin serves the frontend and API
 * (for example, node server/server.js locally). For a Vercel static frontend
 * with a separately hosted API, replace the empty string with the API's exact
 * HTTPS origin before deploying, for example:
 *
 *   window.LARIAT_API_BASE = 'https://api.example.com';
 *
 * This file must contain only a public URL. Never put Open States, Brevo,
 * OpenRouter, or any other secret in browser-delivered code.
 */
window.LARIAT_API_BASE = '';
