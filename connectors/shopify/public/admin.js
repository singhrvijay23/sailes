// SAILES admin page. Every fetch() to this app carries the App Bridge session token.
(function () {
  const $ = (id) => document.getElementById(id);
  const show = (id, on) => ($(id).hidden = !on);
  const PROVIDER_NAMES = { openai: 'OpenAI', gemini: 'Google Gemini', anthropic: 'Anthropic Claude' };
  let ai = null;
  let poll = null;

  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { code: data.error, status: res.status });
    return data;
  }

  function fail(e) {
    $('error-text').textContent = e.message;
    show('error', true);
    show('loading', false);
  }

  function toast(msg, isError) {
    if (window.shopify && window.shopify.toast) window.shopify.toast.show(msg, { isError: Boolean(isError) });
  }

  function renderSync(s) {
    const last = s.lastSync;
    if (!last) {
      $('sync-summary').textContent = 'The first sync starts right after connecting and usually takes a minute or two.';
      show('sync-stats', false);
    } else {
      $('sync-summary').textContent = `Last ${last.kind === 'full' ? 'full sync' : 'sync'}: ${new Date(last.at).toLocaleString()}`;
      for (const k of ['created', 'updated', 'unchanged', 'deleted', 'rejected']) $(`st-${k}`).textContent = String(last[k] ?? 0);
      show('sync-stats', true);
    }
    show('sync-error', Boolean(last && last.error));
    if (last && last.error) $('sync-error-text').textContent = last.error;
  }

  async function load() {
    const s = await api('GET', '/api/status');
    show('loading', false);
    show('error', false);
    show('notice', Boolean(s.notice));
    if (s.notice) $('notice-text').textContent = s.notice;
    show('connect', !s.connected);
    show('connected', s.connected);
    if (!s.connected) return s;
    stopPolling();
    const st = s.store;
    $('store-name').textContent = st.storeName;
    $('plan-badge').textContent = st.plan.charAt(0).toUpperCase() + st.plan.slice(1);
    $('active-badge').textContent = st.active ? 'Active' : 'Inactive';
    $('active-badge').setAttribute('tone', st.active ? 'success' : 'critical');
    show('plan-banner', !st.active);
    $('billing-btn').setAttribute('href', `${st.consoleUrl}/billing`);
    $('console-btn').setAttribute('href', st.consoleUrl);
    $('theme-btn').setAttribute('href', s.themeEditorUrl);
    renderSync(s);
    if (!ai) loadAi().catch(fail);
    return s;
  }

  function fillModels(provider, selected) {
    const p = ai && ai.providers.find((x) => x.id === provider);
    const sel = $('ai-model');
    sel.innerHTML = '';
    for (const m of p ? p.models : []) {
      const o = document.createElement('s-option');
      o.setAttribute('value', m);
      o.textContent = m === p.defaultModel ? `${m} (recommended)` : m;
      sel.appendChild(o);
    }
    sel.value = selected && p && p.models.includes(selected) ? selected : p ? p.defaultModel : '';
  }

  function renderAiMode() {
    const mode = $('ai-mode').value;
    show('byok-fields', mode === 'byok');
    show('managed-note', mode === 'managed');
  }

  async function loadAi() {
    ai = await api('GET', '/api/ai');
    const c = ai.credential;
    $('ai-current').textContent =
      ai.mode === 'byok' && c ? `Now using your ${PROVIDER_NAMES[c.provider] || c.provider} account, model ${c.chat_model}, key ${c.key}.` : ai.mode === 'managed' ? 'Now using SAILES AI credits.' : 'Now in demo mode: answers use keyword search only. Add an AI key for full conversations.';
    $('ai-mode').value = ai.mode === 'managed' ? 'managed' : 'byok'; // demo mode: suggest adding a key
    if (!ai.managedAvailable) $('ai-mode').querySelector('[value="managed"]').setAttribute('disabled', '');
    const provider = c ? c.provider : 'openai';
    $('ai-provider').value = provider;
    fillModels(provider, c && c.chat_model);
    renderAiMode();
  }

  async function saveAi() {
    const mode = $('ai-mode').value;
    const body = { mode };
    if (mode === 'byok') {
      body.provider = $('ai-provider').value;
      body.chatModel = $('ai-model').value;
      const key = $('ai-key').value.trim();
      if (key) body.apiKey = key;
    }
    const btn = $('ai-save');
    btn.loading = true;
    show('ai-result', false);
    try {
      const r = await api('PUT', '/api/ai', body);
      $('ai-key').value = '';
      $('ai-banner').setAttribute('tone', 'success');
      $('ai-result-text').textContent = r.reindexing ? `Saved. Re-indexing ${r.reindexing} products for the new provider; this takes a few minutes.` : 'Saved.';
      show('ai-result', true);
      ai = null;
      await loadAi();
      toast('AI settings saved');
    } catch (e) {
      $('ai-banner').setAttribute('tone', 'critical');
      $('ai-result-text').textContent = e.message;
      show('ai-result', true);
    } finally {
      btn.loading = false;
    }
  }

  function stopPolling() {
    if (poll) clearInterval(poll);
    poll = null;
    show('connect-wait', false);
  }

  async function connect() {
    const btn = $('connect-btn');
    btn.loading = true;
    try {
      const { url } = await api('POST', '/api/connect');
      window.open(url, '_blank');
      show('connect-wait', true);
      stopPolling();
      show('connect-wait', true);
      let tries = 0;
      poll = setInterval(() => {
        if (++tries > 200) return stopPolling();
        load().catch(() => {});
      }, 3000);
    } catch (e) {
      fail(e);
    } finally {
      btn.loading = false;
    }
  }

  async function resync() {
    const btn = $('sync-btn');
    btn.loading = true;
    try {
      await api('POST', '/api/sync');
      toast('Full sync started');
      setTimeout(() => load().catch(fail), 5000);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.loading = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('connect-btn').addEventListener('click', connect);
    $('reconnect-btn').addEventListener('click', connect);
    $('sync-btn').addEventListener('click', resync);
    $('ai-save').addEventListener('click', saveAi);
    $('ai-mode').addEventListener('change', renderAiMode);
    $('ai-provider').addEventListener('change', () => fillModels($('ai-provider').value));
    load().catch(fail);
  });
})();
