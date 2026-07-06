"use strict";

// Supabase project constants (public, safe to embed)
const SUPABASE_URL  = "https://qvbulxpjnrcgxtfxlars.supabase.co";
const SUPABASE_ANON = "sb_publishable_zkc4INigKfJS_f8Oh8_CDg_-hyCYpf2";

/**
 * Exchange a Supabase refresh token for a fresh access token.
 * Returns { accessToken, refreshToken } — use the new refreshToken for
 * the next call (Supabase rotates refresh tokens on each use).
 *
 * @param {string} refreshToken
 * @returns {Promise<{accessToken: string, refreshToken: string}>}
 */
async function exchangeRefreshToken(refreshToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey":       SUPABASE_ANON,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh response missing access_token");

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? refreshToken, // Supabase always returns a new one
  };
}

module.exports = { exchangeRefreshToken };
