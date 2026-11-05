import { render } from 'preact';
import { SailesClient } from './api';
import { App } from './App';
import css from './styles.css';

/**
 * SAILES chat widget. Install with one script tag:
 *   <script src="https://api.sailes.ai/widget/sailes.js" data-sailes-key="pk_..." async></script>
 * Optional attributes: data-api (API origin), data-mode="inline" + data-target="#selector".
 * Renders inside a Shadow DOM so store themes cannot break its styles.
 */
declare global {
  interface Window {
    SAILES?: { open(): void; close(): void; send(text: string): void; mounted: boolean };
  }
}

function boot() {
  if (window.SAILES?.mounted) return;
  const script = (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>('script[data-sailes-key]');
  const key = script?.dataset.sailesKey;
  if (!script || !key) {
    console.warn('SAILES: add data-sailes-key to the script tag');
    return;
  }
  const apiBase = (script.dataset.api ?? new URL(script.src, location.href).origin).replace(/\/$/, '');
  const inline = script.dataset.mode === 'inline';
  const target = inline ? document.querySelector(script.dataset.target ?? '#sailes-chat') : null;

  const host = document.createElement('sailes-chat');
  (target ?? document.body).appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  const mount = document.createElement('div');
  shadow.appendChild(mount);

  const api: { open(): void; close(): void; send(text: string): void } = { open() {}, close() {}, send() {} };
  window.SAILES = {
    mounted: true,
    open: () => api.open(),
    close: () => api.close(),
    send: (t) => api.send(t),
  };
  render(<App client={new SailesClient(apiBase, key)} inline={Boolean(target)} controls={api} />, mount);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
