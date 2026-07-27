/**
 * MERGEN Rota — Keycloak diagnostic.
 *
 * Flow aware: reads MERGEN_ROTA_KEYCLOAK_FLOW and runs the checks that actually
 * apply to the selected flow.
 *
 *   authorization-code : discovery + TLS, authorization request (code + PKCE
 *                        S256), token-endpoint client-authentication probe,
 *                        live login-route inspection.
 *   implicit-bridge    : discovery + TLS, authorization request
 *                        (response_type=token, response_mode=fragment), live
 *                        login-route inspection. The token endpoint is NOT
 *                        used and is not probed.
 *
 * The script never prints secrets, tokens, URL fragments, certificate paths or
 * certificate contents, and never attempts to capture a real access token.
 */
const { loadEnvConfig } = require('@next/env');
const crypto = require('node:crypto');

const FLOWS = { AUTHORIZATION_CODE: 'authorization-code', IMPLICIT_BRIDGE: 'implicit-bridge' };
const SUPPORTED_FLOWS = [FLOWS.AUTHORIZATION_CODE, FLOWS.IMPLICIT_BRIDGE];

function text(value) {
  return String(value ?? '').trim();
}

/** Empty falls back to the default flow; an unknown value is an error, not a fallback. */
function parseFlow(value) {
  const raw = text(value).toLowerCase();
  if (!raw) return FLOWS.AUTHORIZATION_CODE;
  return SUPPORTED_FLOWS.includes(raw) ? raw : null;
}

function deriveIssuer(env) {
  const base = text(env.MERGEN_ROTA_KEYCLOAK_BASE_URL).replace(/\/+$/, '');
  const realm = text(env.MERGEN_ROTA_KEYCLOAK_REALM);
  if (/\/realms\/[^/]+$/.test(base)) return base;
  if (!base || !realm) return '';
  return `${base}/realms/${encodeURIComponent(realm)}`;
}

function truncate(value, max = 300) {
  const raw = text(value);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

async function readJsonSafely(response) {
  const raw = await response.text();
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    return { json: null, raw };
  }
}

function printHeading(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function printResult(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

/**
 * Describes a redirect target without ever exposing token material.
 *
 * With `response_mode=fragment` Keycloak returns authorization errors in the
 * URL fragment rather than the query string, so both are inspected. Only the
 * non-sensitive `error` / `error_description` fields are read from the
 * fragment; `access_token` and friends are reported as a boolean at most and
 * their values are never read, stored or printed.
 */
function describeRedirect(location, requestUrl, expectedCallback) {
  if (!location) return null;
  const target = new URL(location, requestUrl);
  const callback = new URL(expectedCallback);
  const rawFragment = target.hash.startsWith('#') ? target.hash.slice(1) : target.hash;
  const fragment = new URLSearchParams(rawFragment);

  return {
    target: `${target.origin}${target.pathname}`,
    returnsToConfiguredCallback: `${target.origin}${target.pathname}` === `${callback.origin}${callback.pathname}`,
    // Query string first (code flow), then fragment (implicit flow).
    error: target.searchParams.get('error') || fragment.get('error') || null,
    errorDescription: truncate(target.searchParams.get('error_description') || fragment.get('error_description')),
    errorLocation: target.searchParams.has('error') ? 'query' : (fragment.has('error') ? 'fragment' : null),
    authorizationCodeReturned: target.searchParams.has('code'),
    // Never read: only the PRESENCE of token material is reported.
    accessTokenReturned: fragment.has('access_token'),
    fragmentPresent: Boolean(rawFragment)
  };
}

async function inspectLiveLoginRoute({ callbackUrl, expectations }) {
  const callback = new URL(callbackUrl);
  const localPort = callback.port || (callback.protocol === 'https:' ? '443' : '80');
  const localScheme = callback.protocol === 'https:' ? 'https:' : 'http:';
  const localLoginUrl = `${localScheme}//127.0.0.1:${localPort}/api/mergen-rota/auth/login`;

  try {
    const liveResponse = await fetch(localLoginUrl, { redirect: 'manual' });
    const liveLocation = liveResponse.headers.get('location');
    const setCookie = liveResponse.headers.get('set-cookie') || '';
    let liveInfo = null;

    if (liveLocation) {
      const target = new URL(liveLocation);
      liveInfo = {
        targetHost: target.host,
        clientId: target.searchParams.get('client_id'),
        redirectUri: target.searchParams.get('redirect_uri'),
        responseType: target.searchParams.get('response_type'),
        responseMode: target.searchParams.get('response_mode'),
        pkceMethod: target.searchParams.get('code_challenge_method'),
        pkceChallengePresent: target.searchParams.has('code_challenge'),
        scope: target.searchParams.get('scope')
      };
    }

    const mismatches = liveInfo
      ? Object.entries(expectations).filter(([key, expected]) => liveInfo[key] !== expected).map(([key]) => key)
      : ['(no redirect returned)'];

    printResult({
      url: localLoginUrl,
      httpStatus: liveResponse.status,
      authorizationRequest: liveInfo,
      // Only the cookie NAME is reported; the signed value is never printed.
      transactionCookieName: setCookie ? setCookie.split('=')[0] : null,
      expected: expectations,
      mismatches,
      interpretation: mismatches.length === 0
        ? 'GOOD: the running MERGEN Rota process emits exactly the expected authorization request for the selected flow.'
        : 'CHECK: the running application may be using different/stale environment values, a different flow, or it is not running.'
    });
  } catch (error) {
    printResult({
      url: localLoginUrl,
      skipped: true,
      reason: `Could not reach the running application: ${error.message}`,
      note: 'Start MERGEN Rota in another CMD window and run this script again.'
    });
  }
}

async function diagnoseAuthorizationCode({ authorizationEndpoint, tokenEndpoint, clientId, clientSecret, redirectUri, scope }) {
  printHeading('TEST 3 — Authorization endpoint: client + redirect + Code Flow + PKCE S256');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: crypto.randomBytes(24).toString('base64url'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'none'
  }).toString();

  const authorizationResponse = await fetch(authorizationUrl, {
    redirect: 'manual',
    headers: { accept: 'text/html,application/xhtml+xml' }
  });

  const locationInfo = describeRedirect(authorizationResponse.headers.get('location'), authorizationUrl, redirectUri);

  printResult({
    httpStatus: authorizationResponse.status,
    location: locationInfo,
    interpretation:
      locationInfo?.returnsToConfiguredCallback && locationInfo?.error === 'login_required'
        ? 'GOOD: Keycloak accepted the client ID, redirect URI, Authorization Code request and PKCE S256. login_required is expected because this Node request has no browser SSO cookie.'
        : locationInfo?.error === 'unauthorized_client'
          ? 'ROOT CAUSE LIKELY: this client is not allowed to use Authorization Code / Standard Flow.'
          : locationInfo?.error
            ? `KEYCLOAK REJECTED REQUEST: ${locationInfo.error}`
            : 'INCONCLUSIVE: inspect the status and redirect target above.'
  });

  printHeading('TEST 4 — Token endpoint client-authentication probe using an intentionally invalid code');
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: 'MERGEN_ROTA_DIAGNOSTIC_INVALID_CODE',
    redirect_uri: redirectUri,
    code_verifier: verifier
  });

  if (clientSecret) tokenBody.set('client_secret', clientSecret);

  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: tokenBody.toString()
  });

  const tokenPayload = await readJsonSafely(tokenResponse);
  const tokenError = tokenPayload.json?.error || null;
  const tokenErrorDescription = truncate(tokenPayload.json?.error_description);
  const looksLikeClientAuthentication = /invalid client/i.test(tokenErrorDescription);

  let tokenInterpretation = 'INCONCLUSIVE: inspect the response.';
  if (tokenError === 'invalid_grant') {
    tokenInterpretation = 'GOOD: Keycloak recognized the client and accepted the configured client authentication. invalid_grant is expected because the diagnostic code is deliberately fake. A missing client secret is therefore unlikely to be the problem.';
  } else if (tokenError === 'invalid_client') {
    tokenInterpretation = 'ROOT CAUSE LIKELY: wrong client ID, or the client is confidential and the configured secret is missing/incorrect.';
  } else if (tokenError === 'unauthorized_client') {
    // Keycloak reuses `unauthorized_client` for BOTH "grant not allowed" and
    // "client authentication failed". HTTP 401 plus an "Invalid client or
    // Invalid client credentials" description is the credential case: TEST 3
    // already proved the authorization endpoint accepts Standard Flow for this
    // client, so the grant is enabled and only the token-endpoint client
    // authentication is missing.
    tokenInterpretation = looksLikeClientAuthentication || tokenResponse.status === 401
      ? 'ROOT CAUSE LIKELY: CONFIDENTIAL-CLIENT AUTHENTICATION FAILED at the token endpoint (HTTP 401 + "Invalid client or Invalid client credentials"). This does NOT mean Standard Flow is disabled — TEST 3 shows the authorization request is accepted. It means the token exchange needs a valid client credential that is not configured. Either obtain the client secret, make the client public, or select MERGEN_ROTA_KEYCLOAK_FLOW=implicit-bridge for a client that already works with the implicit flow.'
      : 'ROOT CAUSE LIKELY: this client is not permitted to use this grant/flow.';
  }

  printResult({
    tokenEndpoint,
    httpStatus: tokenResponse.status,
    error: tokenError,
    errorDescription: tokenErrorDescription,
    clientId,
    clientSecretSupplied: Boolean(clientSecret),
    interpretation: tokenInterpretation,
    responsePreview: tokenPayload.json ? null : truncate(tokenPayload.raw)
  });

  printHeading('TEST 5 — Optional live MERGEN Rota login route');
  await inspectLiveLoginRoute({
    callbackUrl: redirectUri,
    expectations: {
      clientId,
      redirectUri,
      responseType: 'code',
      responseMode: null,
      pkceMethod: 'S256',
      pkceChallengePresent: true
    }
  });
}

async function diagnoseImplicitBridge({ authorizationEndpoint, clientId, implicitRedirectUri, scope }) {
  printHeading('TEST 3 — Authorization endpoint: client + implicit redirect + response_type=token');
  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'token',
    response_mode: 'fragment',
    client_id: clientId,
    redirect_uri: implicitRedirectUri,
    scope,
    state: crypto.randomBytes(24).toString('base64url'),
    // Noninteractive: without a browser SSO cookie Keycloak answers
    // login_required, so no real token is ever issued to this script.
    prompt: 'none'
  }).toString();

  const authorizationResponse = await fetch(authorizationUrl, {
    redirect: 'manual',
    headers: { accept: 'text/html,application/xhtml+xml' }
  });

  const locationInfo = describeRedirect(authorizationResponse.headers.get('location'), authorizationUrl, implicitRedirectUri);

  printResult({
    httpStatus: authorizationResponse.status,
    location: locationInfo,
    note: 'With response_mode=fragment the authorization error arrives in the URL fragment, so only the error fields are read from it. Token material is reported as a boolean at most; its value is never read, stored or printed.',
    interpretation:
      locationInfo?.accessTokenReturned
        ? 'UNEXPECTED: Keycloak returned token material to this noninteractive probe. The diagnostic did not read or store it. Re-run from a session without a Keycloak SSO cookie.'
        : locationInfo?.returnsToConfiguredCallback && locationInfo?.error === 'login_required'
          ? 'GOOD: Keycloak accepted the client ID, the implicit callback redirect URI and the implicit (response_type=token) request. login_required is expected because this Node request has no browser SSO cookie.'
          : locationInfo?.error === 'unauthorized_client'
          ? 'ROOT CAUSE LIKELY: this client is not allowed to use the implicit flow.'
          : locationInfo?.error === 'invalid_request'
            ? 'CHECK: the implicit redirect URI is probably not registered for this client, or the implicit flow is disabled.'
            : locationInfo?.error
              ? `KEYCLOAK REJECTED REQUEST: ${locationInfo.error}`
              : 'INCONCLUSIVE: inspect the status and redirect target above.'
  });

  printHeading('TEST 4 — Token endpoint (skipped by design)');
  printResult({
    tokenEndpointUsed: false,
    clientSecretRequired: false,
    interpretation: 'The implicit bridge never calls the token endpoint, so confidential-client authentication is not required and is not probed. The access token is verified against the realm JWKS on the MERGEN Rota server instead.'
  });

  printHeading('TEST 5 — Optional live MERGEN Rota login route');
  await inspectLiveLoginRoute({
    callbackUrl: implicitRedirectUri,
    expectations: {
      clientId,
      redirectUri: implicitRedirectUri,
      responseType: 'token',
      responseMode: 'fragment',
      pkceMethod: null,
      pkceChallengePresent: false
    }
  });
}

async function main() {
  const loaded = loadEnvConfig(process.cwd(), false);
  const env = process.env;

  const flow = parseFlow(env.MERGEN_ROTA_KEYCLOAK_FLOW);
  const issuer = deriveIssuer(env);
  const clientId = text(env.MERGEN_ROTA_KEYCLOAK_CLIENT_ID);
  const clientSecret = text(env.MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET);
  const redirectUri = text(env.MERGEN_ROTA_KEYCLOAK_REDIRECT_URI);
  const implicitRedirectUri = text(env.MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI);
  const scope = text(env.MERGEN_ROTA_KEYCLOAK_SCOPE) || 'openid profile email';

  printHeading('TEST 1 — Effective configuration loaded by Next.js');
  printResult({
    workingDirectory: process.cwd(),
    loadedEnvFiles: (loaded.loadedEnvFiles || []).map((item) => item.path),
    authMode: text(env.MERGEN_ROTA_AUTH_MODE),
    keycloakFlow: flow || `INVALID (${truncate(env.MERGEN_ROTA_KEYCLOAK_FLOW, 40)})`,
    supportedFlows: SUPPORTED_FLOWS,
    issuer,
    realm: text(env.MERGEN_ROTA_KEYCLOAK_REALM),
    clientId,
    clientSecretSupplied: Boolean(clientSecret),
    redirectUri,
    implicitRedirectUri,
    postLogoutRedirectUri: text(env.MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI),
    scope,
    expectedAudience: text(env.MERGEN_ROTA_KEYCLOAK_AUDIENCE) || '(defaults to client ID)',
    expectedAuthorizedParty: text(env.MERGEN_ROTA_KEYCLOAK_AUTHORIZED_PARTY) || '(defaults to client ID)',
    sessionSecretLength: text(env.MERGEN_ROTA_SESSION_SECRET).length,
    sessionCookieSecure: text(env.MERGEN_ROTA_SESSION_COOKIE_SECURE),
    // Only whether it is set. The path itself is deployment specific and is
    // never printed.
    nodeExtraCaCertsConfigured: Boolean(text(env.NODE_EXTRA_CA_CERTS))
  });

  if (!flow) {
    throw new Error(`MERGEN_ROTA_KEYCLOAK_FLOW is invalid. Supported values: ${SUPPORTED_FLOWS.join(', ')}.`);
  }
  if (!issuer || !clientId) {
    throw new Error('Required issuer/client ID values are missing from the effective environment.');
  }
  if (flow === FLOWS.AUTHORIZATION_CODE && !redirectUri) {
    throw new Error('MERGEN_ROTA_KEYCLOAK_REDIRECT_URI is required for the authorization-code flow.');
  }
  if (flow === FLOWS.IMPLICIT_BRIDGE && !implicitRedirectUri) {
    throw new Error('MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI is required to diagnose the implicit-bridge flow.');
  }

  printHeading('TEST 2 — OIDC discovery and Node TLS trust');
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const discoveryResponse = await fetch(discoveryUrl, {
    headers: { accept: 'application/json' }
  });
  const discoveryBody = await readJsonSafely(discoveryResponse);

  printResult({
    url: discoveryUrl,
    httpStatus: discoveryResponse.status,
    issuerReturned: discoveryBody.json?.issuer || null,
    authorizationEndpoint: discoveryBody.json?.authorization_endpoint || null,
    tokenEndpoint: discoveryBody.json?.token_endpoint || null,
    jwksUri: discoveryBody.json?.jwks_uri || null,
    codeChallengeMethodsSupported: discoveryBody.json?.code_challenge_methods_supported || null,
    responseTypesSupported: discoveryBody.json?.response_types_supported || null,
    responseModesSupported: discoveryBody.json?.response_modes_supported || null,
    responsePreview: discoveryBody.json ? null : truncate(discoveryBody.raw)
  });

  if (!discoveryResponse.ok || !discoveryBody.json) {
    throw new Error('OIDC discovery failed. Fix TLS/network/issuer before continuing.');
  }

  const authorizationEndpoint = discoveryBody.json.authorization_endpoint || `${issuer}/protocol/openid-connect/auth`;
  const tokenEndpoint = discoveryBody.json.token_endpoint || `${issuer}/protocol/openid-connect/token`;

  if (flow === FLOWS.IMPLICIT_BRIDGE) {
    await diagnoseImplicitBridge({ authorizationEndpoint, clientId, implicitRedirectUri, scope });
  } else {
    await diagnoseAuthorizationCode({ authorizationEndpoint, tokenEndpoint, clientId, clientSecret, redirectUri, scope });
  }

  printHeading('SUMMARY');
  console.log(flow === FLOWS.IMPLICIT_BRIDGE
    ? [
      'Selected flow: implicit-bridge.',
      'Send back the complete output of TEST 3 and TEST 5.',
      'TEST 3 shows whether Keycloak accepts this client with the implicit',
      'callback redirect URI; TEST 5 shows whether the running application',
      'actually emits response_type=token, response_mode=fragment and no PKCE.',
      'The token endpoint is deliberately not used in this flow, so no client',
      'secret is needed. NODE_EXTRA_CA_CERTS may still be required because the',
      'server keeps fetching the realm JWKS to verify the access token.'
    ].join('\n')
    : [
      'Selected flow: authorization-code.',
      'Send back the complete output of TEST 3 and TEST 4.',
      'Those two results usually identify whether the problem is:',
      '  • redirect/client/Standard Flow/PKCE configuration,',
      '  • confidential-client authentication at the token endpoint, or',
      '  • something later in the real one-time code exchange.',
      'HTTP 401 + unauthorized_client + "Invalid client or Invalid client',
      'credentials" in TEST 4, together with a GOOD TEST 3, means the token',
      'exchange lacks a valid client credential — not that Standard Flow is off.'
    ].join('\n'));
}

// Doğrudan çalıştırıldığında teşhis akar; içe aktarıldığında yalnızca saf
// yardımcılar açığa çıkar (testler bunları çevrimdışı doğrular).
if (require.main === module) {
  main().catch((error) => {
    console.error('\nDIAGNOSTIC FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { describeRedirect, parseFlow, deriveIssuer, SUPPORTED_FLOWS };
