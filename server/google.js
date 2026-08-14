/* Bureau du Courrier — connexion d'une boîte Gmail par OAuth 2.0.

   L'employé·e autorise l'application à envoyer en son nom depuis l'écran de
   consentement Google. L'application ne voit jamais son mot de passe, et
   l'autorisation se révoque côté Google à tout moment
   (https://myaccount.google.com/permissions).

   On ne demande que deux autorisations :
     gmail.send      — envoyer un courriel, sans aucun accès en lecture ;
     userinfo.email  — connaître l'adresse connectée, pour l'afficher.

   Configuration nécessaire (voir docs/connexion-boite-mail.md) :
     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, et l'URI de redirection déclarée
     dans la console Google Cloud. */
'use strict';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email'];

function readConfig(env) {
  const e = env || process.env;
  return {
    clientId: e.GOOGLE_CLIENT_ID || '',
    clientSecret: e.GOOGLE_CLIENT_SECRET || '',
    redirectUri: e.GOOGLE_REDIRECT_URI || ''
  };
}

function createGoogleOAuth(env, deps) {
  const config = readConfig(env);
  const doFetch = (deps && deps.fetch) || globalThis.fetch;
  const enabled = !!(config.clientId && config.clientSecret);

  /** L'URI de redirection doit correspondre au caractère près à celle déclarée chez Google. */
  function redirectUri(req) {
    if (config.redirectUri) return config.redirectUri;
    const host = (req && req.headers && req.headers.host) || 'localhost:3000';
    const proto = req && req.headers && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http';
    return proto + '://' + host + '/api/auth/google/callback';
  }

  function authUrl(state, uri) {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: uri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      // offline + consent : indispensables pour recevoir un jeton de
      // rafraîchissement, sans lequel l'autorisation expirerait en une heure.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: state
    });
    return AUTH_ENDPOINT + '?' + params.toString();
  }

  async function exchangeCode(code, uri) {
    const res = await doFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: uri,
        grant_type: 'authorization_code'
      }).toString()
    });
    const payload = await res.json().catch(function () {
      return null;
    });
    if (!res.ok || !payload) {
      const detail = (payload && (payload.error_description || payload.error)) || 'réponse illisible';
      throw new Error('Google a refusé l’autorisation : ' + detail);
    }
    if (!payload.refresh_token) {
      throw new Error(
        'Google n’a pas fourni de jeton durable. Retirez l’accès sur ' +
          'https://myaccount.google.com/permissions puis recommencez.'
      );
    }
    return payload;
  }

  async function fetchEmail(accessToken) {
    const res = await doFetch(USERINFO_ENDPOINT, {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const payload = await res.json().catch(function () {
      return null;
    });
    if (!res.ok || !payload || !payload.email) {
      throw new Error('Adresse Google illisible.');
    }
    return payload.email;
  }

  return {
    enabled: enabled,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: SCOPES,
    redirectUri: redirectUri,
    authUrl: authUrl,
    exchangeCode: exchangeCode,
    fetchEmail: fetchEmail
  };
}

module.exports = { createGoogleOAuth: createGoogleOAuth, SCOPES: SCOPES };
